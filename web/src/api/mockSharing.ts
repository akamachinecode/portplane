import { ApiError } from "./errors";
import type { Job } from "./jobs";
import type { MockContext } from "./mockContext";
import type { CA, FileEdit, NameInfo, NamePreview, Plan, ProxyOptions, RouteView, SharedUrl } from "./portless";
import type {
  ComposeOverview,
  ComposePlan,
  ComposeProject,
  ComposeRequest,
  LanView,
  Requirement,
  ShareInfo,
  ShareKind,
  SharePreview,
  ShareProvider,
  SharingApi,
  SharingOverview,
} from "./sharing";
import type { App, MachineSnapshot } from "./types";
import { composeNameProblem, proxyUrl } from "../lib/portless";
import { composeHostnames, SHARE_KINDS } from "../lib/sharing";

// The in-memory side of sharing.ts for `?mock` and tests. Scenarios:
//   default   Tailscale ready (Funnel not allowed), ngrok without its
//             authtoken, no cloudflared; web is shared on the tailnet
//   tailnet   everything ready; web on the tailnet, api on Funnel, and a
//             share started outside Portplane
//   bare      no Tailscale, ngrok, cloudflared, Docker or Avahi
//   compose   a running compose project, a stopped one and one Portplane
//             remembers after `down`

const HOME = "/home/dev";
const ROOT = `${HOME}/code`;
const FRAGMENT = `${ROOT}/.portplane/tasks.yaml`;
const BIN = `${HOME}/.npm-global/bin/portless`;
const TAILNET = "workstation.tail4c2a.ts.net";
const NODE_ID = "nAbCdEf1CNTRL";

interface Tools {
  tailscale: "missing" | "ready";
  funnel: boolean;
  operator: boolean;
  ngrok: boolean;
  ngrokToken: boolean;
  cloudflared: boolean;
  docker: boolean;
  avahi: boolean;
}

interface ComposeMock {
  name: string;
  file: string;
  state: "running" | "stopped" | "down";
  known: boolean;
  /** service name → its portless.name label */
  names: Record<string, string>;
  services: ComposeProject["services"];
}

/** What the sharing mock needs from the portless mock. */
export interface SharingHooks {
  installed(): boolean;
  tlds(): string[];
  proxy(): { port: number; https: boolean };
  options(): ProxyOptions;
  serviceInstalled(): boolean;
  responding(): boolean;
  ca(): CA;
  /** Every route the portless mock knows, compose ones included. */
  routes(): RouteView[];
}

export interface MockSharing extends SharingApi {
  /** The shares routes.json records for a hostname. */
  sharedFor(hostname: string): SharedUrl[];
  /** Routes the sharing mock adds: compose aliases, and shares started outside Portplane. */
  extraRoutes(): RouteView[];
  composeNameInfo(route: string): NameInfo;
  composeNamePreview(route: string, name: string): NamePreview;
  composeRename(route: string, name: string, digest: string): Job;
  /** The portless action that makes the user Tailscale's operator. */
  operatorPlan(): Plan;
  operatorDone(): void;
}

function toolsFor(scenario: string): Tools {
  switch (scenario) {
    case "tailnet":
      return { tailscale: "ready", funnel: true, operator: true, ngrok: true, ngrokToken: true, cloudflared: true, docker: true, avahi: true };
    case "bare":
      return { tailscale: "missing", funnel: false, operator: false, ngrok: false, ngrokToken: false, cloudflared: false, docker: false, avahi: false };
    default:
      return { tailscale: "ready", funnel: false, operator: true, ngrok: true, ngrokToken: false, cloudflared: false, docker: true, avahi: true };
  }
}

function composeFor(scenario: string): ComposeMock[] {
  if (scenario !== "compose") return [];
  return [
    {
      name: "shop",
      file: `${ROOT}/shop/compose.yaml`,
      state: "running",
      known: true,
      names: { api: "backend" },
      services: [
        { name: "api", label: "backend", nameLabel: "backend", enabled: true, image: undefined, ports: [{ target: 8080, hostPort: 14002, routed: true }, { target: 9229, hostPort: 14003, routed: true }] },
        { name: "db", label: "db", enabled: true, image: "postgres:17", ports: [{ target: 5432, hostPort: 5432, routed: false, reason: "not HTTP" }] },
        { name: "mail", label: "mail", enabled: false, image: "axllent/mailpit:v1.27", ports: [{ target: 8025, hostPort: 8025, routed: false, reason: "portless.enable=false" }] },
        { name: "web", label: "web", enabled: true, ports: [{ target: 5173, hostPort: 14001, routed: true }] },
        { name: "worker", label: "worker", enabled: true, ports: [] },
      ],
    },
    {
      name: "analytics",
      file: `${ROOT}/analytics/docker-compose.yml`,
      state: "stopped",
      known: true,
      names: {},
      services: [{ name: "dashboard", label: "dashboard", enabled: true, ports: [{ target: 3000, hostPort: 14010, routed: true }] }],
    },
    { name: "legacy", file: `${ROOT}/legacy/compose.yaml`, state: "down", known: false, names: {}, services: [] },
  ];
}

const shareUrl = (kind: ShareKind, i: number, host: string) => {
  const slug = host.split(".")[0];
  switch (kind) {
    case "tailscale":
    case "funnel":
      return i === 0 ? `https://${TAILNET}` : `https://${TAILNET}:${[8443, 10000, 8444][i - 1] ?? 8445}`;
    case "ngrok":
      return `https://${slug}-3f2a-81-0-0-1.ngrok-free.app`;
    case "cloudflare":
      return `https://calm-river-${slug}-tree.trycloudflare.com`;
  }
};

export function createMockSharing(ctx: MockContext, hooks: SharingHooks): MockSharing {
  const scenario = String(ctx.scenario);
  const tools = toolsFor(scenario);
  const compose = composeFor(scenario);
  /** App id → the shares its command turns on. */
  const flags = new Map<string, ShareKind[]>();
  if (scenario === "default" || scenario === "tailnet" || scenario === "compose") flags.set(`${ROOT}#my-monorepo/web`, ["tailscale"]);
  if (scenario === "tailnet") flags.set(`${ROOT}#my-monorepo/api`, ["funnel"]);

  const local = (): MachineSnapshot => ctx.snapshot().machines.find((m) => m.machine.local)!;
  const need = () => {
    if (!hooks.installed()) throw new ApiError("portless isn't installed on this computer: install it from Settings → Tools or the welcome screen", 503);
  };
  const appByHost = (host: string) => local().apps.find((a) => a.hostname === host);

  // ---- requirements ----

  const req = (id: string, ok: boolean, label: string, extra: Partial<Requirement> = {}): Requirement => ({ id, ok, label, ...(ok ? {} : extra) });
  const tailscaleReqs = (funnel: boolean): Requirement[] => {
    if (tools.tailscale === "missing") {
      return [req("tailscale-installed", false, "Tailscale is installed", { problem: "Tailscale isn't installed. Sharing on your tailnet goes through it.", fix: "Install Tailscale and sign in to your tailnet, then check again.", url: "https://tailscale.com/download" })];
    }
    const out = [req("tailscale-installed", true, "Tailscale is installed"), req("tailscale-running", true, "Tailscale is connected"), req("tailscale-https", true, "Your tailnet issues HTTPS certificates")];
    out.push(req("tailscale-operator", tools.operator, "Tailscale lets your user share", { problem: "On Linux, Tailscale only lets the administrator, or the user set as its operator, share apps.", fix: "Make dev Tailscale's operator. It asks for your password once; Tailscale keeps the setting.", command: "sudo tailscale set --operator=dev", action: "tailscale-operator" }));
    if (funnel) {
      out.push(req("tailscale-funnel", tools.funnel, "Your tailnet allows Funnel on this computer", { problem: "Your tailnet's policy doesn't let this computer use Funnel, which is what makes a Tailscale address public.", fix: "An admin of your tailnet turns Funnel on for this computer. The page explains how and can do it for you.", url: `https://login.tailscale.com/f/funnel?node=${NODE_ID}` }));
    }
    return out;
  };
  const providers = (): ShareProvider[] => {
    const where = tools.tailscale === "ready" ? `https://${TAILNET}` : "https://<this computer>.<your tailnet>.ts.net";
    const list: ShareProvider[] = [
      { kind: "tailscale", label: "Your tailnet", public: false, ready: false, where, requirements: tailscaleReqs(false), notes: ["Only devices signed in to your tailnet can open it. Each shared app takes the next free HTTPS port: 443, then 8443 and up."] },
      { kind: "funnel", label: "Public, with Tailscale Funnel", public: true, ready: false, where, requirements: tailscaleReqs(true), notes: ["Anyone on the internet with the address can open it. Funnel offers three ports (443, 8443 and 10000), so at most three apps at once."] },
      {
        kind: "ngrok",
        label: "Public, with ngrok",
        public: true,
        ready: false,
        where: "https://<random>.ngrok-free.app",
        requirements: [
          req("ngrok-installed", tools.ngrok, "ngrok is installed", { problem: "ngrok isn't installed.", fix: "Install ngrok and create a free account, then check again.", command: "sudo snap install ngrok", url: "https://ngrok.com/download" }),
          req("ngrok-authtoken", tools.ngrokToken, "ngrok knows your account", { problem: "ngrok needs your account's authtoken before it opens a tunnel.", fix: "Copy your authtoken from the ngrok dashboard and paste it here; Portplane saves it in ngrok's own config.", command: "ngrok config add-authtoken <token>", url: "https://dashboard.ngrok.com/get-started/your-authtoken", action: "ngrok-authtoken" }),
        ],
        notes: ["Anyone on the internet with the address can open it. On ngrok's free plan, visitors see an ngrok notice first."],
      },
      {
        kind: "cloudflare",
        label: "Public, with Cloudflare",
        public: true,
        ready: false,
        where: "https://<random>.trycloudflare.com",
        requirements: [req("cloudflared-installed", tools.cloudflared, "cloudflared is installed", { problem: "cloudflared, Cloudflare's tunnel program, isn't installed.", fix: "Install cloudflared, then check again. Quick tunnels need no Cloudflare account.", url: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" })],
        notes: ["Anyone on the internet with the address can open it. The address changes every time the app restarts.", "Quick tunnels need outbound UDP port 7844; on networks that block it, set TUNNEL_TRANSPORT_PROTOCOL=http2 in the app's environment."],
      },
    ];
    for (const p of list) {
      p.ready = p.requirements.every((r) => r.ok);
      if (!p.ready) p.notes = [];
    }
    return list;
  };

  // ---- shares ----

  /** Running apps that share, in a stable order, for tailnet port numbers. */
  const sharedFor = (hostname: string): SharedUrl[] => {
    const app = appByHost(hostname);
    if (app) {
      if (app.state !== "on") return [];
      const kinds = flags.get(app.id) ?? [];
      const ts = [...flags.entries()].filter(([id, k]) => k.some((x) => x === "tailscale" || x === "funnel") && local().apps.some((a) => a.id === id && a.state === "on")).map(([id]) => id);
      return kinds.map((kind) => ({ kind, url: shareUrl(kind, Math.max(0, ts.indexOf(app.id)), hostname) }));
    }
    if (hostname === "storybook.localhost" && scenario === "tailnet") return [{ kind: "ngrok", url: "https://storybook-77c1.ngrok-free.app" }];
    return [];
  };

  const composeRoutes = (): RouteView[] => {
    const tld = hooks.tlds()[0];
    const out: RouteView[] = [];
    for (const p of compose) {
      if (p.state === "down") continue;
      for (const s of p.services) {
        const hosts = composeHostnames({ label: p.name }, s, tld);
        const port = s.ports.find((x) => x.routed)?.hostPort ?? 0;
        for (const h of hosts) {
          out.push({ hostname: h, port, pid: 0, registeredAt: Date.now() - 50 * 60_000, alive: true, kind: "compose", compose: p.name, shared: [], url: proxyUrl(h, hooks.proxy()), owner: { kind: "compose", label: `docker compose project ${p.name}` } });
        }
      }
    }
    return out;
  };

  const extraRoutes = (): RouteView[] => {
    const out = composeRoutes();
    if (scenario === "tailnet") {
      out.push({ hostname: "storybook.localhost", port: 6006, pid: 52011, registeredAt: Date.now() - 12 * 60_000, alive: true, kind: "app", shared: sharedFor("storybook.localhost"), url: proxyUrl("storybook.localhost", hooks.proxy()), owner: { kind: "process", label: "node", pid: 52011, process: "node" } });
    }
    return out;
  };

  const shareInfo = (machine: string, id: string): ShareInfo => {
    need();
    const ms = local();
    if (machine && machine !== ms.machine.id) throw new ApiError("apps on other machines can be shared from that machine for now; remote machines get this later", 400);
    const app = ms.apps.find((a) => a.id === id);
    if (!app) throw new ApiError(`unknown app "${id}"`, 400);
    const info: ShareInfo = { hostname: app.hostname ?? "", source: "none", editable: false, running: ["on", "starting", "stopping"].includes(app.state), on: [...(flags.get(app.id) ?? [])], env: [], shared: app.hostname ? sharedFor(app.hostname) : [], providers: providers() };
    if (!app.hostname || app.kind === "job") {
      info.reason = "portless shares only the apps it starts, and this app's command doesn't run through portless <name> or portless run.";
      return info;
    }
    if (app.task === "blog/studio") {
      return { ...info, source: "task", file: `${ROOT}/dekit.yaml`, task: app.task, reason: "This task's command is written as JavaScript (!js or a script), which Portplane doesn't rewrite. Add --tailscale after the app's name there in your editor." };
    }
    const fragment = app.command?.[0] === "portless" && app.task !== "my-monorepo/api";
    return { ...info, source: fragment ? "fragment" : "task", file: fragment ? FRAGMENT : `${ROOT}/dekit.yaml`, task: app.task, editable: true };
  };

  const cmdLine = (app: App, kinds: ShareKind[]) => {
    const words = app.command && app.command[0] === "portless" ? [...app.command] : ["portless", app.hostname?.replace(/\.localhost$/, "") ?? app.label, "pnpm", "run", "dev"];
    words.splice(2, 0, ...kinds.map((k) => `--${k}`));
    return `[${words.map((w) => `"${w}"`).join(", ")}]`;
  };
  const fileEdit = (info: ShareInfo, app: App, before: ShareKind[], after: ShareKind[]): FileEdit => {
    const block = (kinds: ShareKind[]) => `# Generated by Portplane (https://github.com/akamachinecode/portplane).\ntasks:\n  ${app.task}:\n    label: "${app.label}"\n    cwd: "../${(app.dir ?? "").replace(`${ROOT}/`, "")}"\n    cmd: ${cmdLine(app, kinds)}\n`;
    return { path: info.file!, before: block(before), after: block(after), created: false, changed: true };
  };
  const nextKinds = (cur: ShareKind[], kind: ShareKind, on: boolean): ShareKind[] => {
    const drop = new Set<ShareKind>([kind]);
    if (on && kind === "tailscale") drop.add("funnel");
    if (on && kind === "funnel") drop.add("tailscale");
    return [...(on ? [kind] : []), ...cur.filter((k) => !drop.has(k))];
  };

  const preview = (machine: string, id: string, kind: ShareKind, on: boolean): SharePreview => {
    const info = shareInfo(machine, id);
    const app = local().apps.find((a) => a.id === id)!;
    const label = { tailscale: "Tailscale", funnel: "Tailscale Funnel", ngrok: "ngrok", cloudflare: "Cloudflare Tunnel" }[kind];
    const pv: SharePreview = { kind, on, public: on && kind !== "tailscale", missing: [], files: [], steps: [], warnings: [] };
    if (!SHARE_KINDS.includes(kind)) return { ...pv, problem: `unknown share "${kind}"` };
    if (!info.editable) return { ...pv, problem: info.reason };
    if (on === info.on.includes(kind)) return { ...pv, problem: on ? `${app.label} is already shared with ${label}.` : `${app.label} isn't shared with ${label}.` };
    if (on) {
      pv.missing = (providers().find((p) => p.kind === kind)?.requirements ?? []).filter((r) => !r.ok);
      if (pv.missing.length) return { ...pv, problem: `This computer isn't ready to share with ${label} yet. Fix what's missing first.` };
      if (kind === "tailscale" && info.on.includes("funnel")) pv.replaces = "funnel";
      if (kind === "funnel" && info.on.includes("tailscale")) pv.replaces = "tailscale";
    }
    pv.files.push(fileEdit(info, app, info.on, nextKinds(info.on, kind, on)));
    pv.steps.push(`Write ${info.file!.split("/").pop()}`, "Reload dekit");
    if (info.running) pv.steps.push(`Restart ${app.label}`);
    else if (on) pv.steps.push(`Start ${app.label}`);
    if (on) pv.steps.push("Wait for the shared address");
    if (pv.public) pv.warnings.push(`Anyone on the internet who has the address can open ${app.label} while it's shared. Share only an app with no real data, or one that asks for a login.`);
    else if (on) pv.warnings.push(`Everyone on your tailnet can open ${app.label} while it's shared.`);
    if (pv.replaces) pv.warnings.push(`This replaces sharing with ${pv.replaces === "funnel" ? "Tailscale Funnel" : "Tailscale"}: an app is shared on the tailnet or publicly through Funnel, not both.`);
    if (!on && !info.running) pv.warnings.push(`${app.label} isn't running; the change applies the next time it starts.`);
    pv.digest = `mock-share-${id}-${info.on.join(",")}`;
    return pv;
  };

  const share = (machine: string, id: string, kind: ShareKind, on: boolean, digest: string, confirmPublic: boolean): Job => {
    const pv = preview(machine, id, kind, on);
    if (pv.problem) throw new ApiError(pv.problem, 400);
    if (pv.public && !confirmPublic) throw new ApiError("sharing publicly needs your confirmation that the app becomes reachable from the internet", 400);
    if (digest !== pv.digest) throw new ApiError("the file changed since the preview: review the new preview and apply again", 409);
    const app = local().apps.find((a) => a.id === id)!;
    const name = { tailscale: "Tailscale", funnel: "Tailscale Funnel", ngrok: "ngrok", cloudflare: "Cloudflare Tunnel" }[kind];
    const next = nextKinds(flags.get(id) ?? [], kind, on);
    const url = shareUrl(kind, 0, app.hostname ?? app.label);
    const job = ctx.jobs.start({
      kind: "portless.share",
      title: on ? `Share ${app.label} with ${name}` : `Stop sharing ${app.label} with ${name}`,
      steps: pv.steps.map((s) => ({
        name: s,
        ms: s.startsWith("Wait") ? 2200 : s.startsWith("Restart") || s.startsWith("Start") ? 1200 : 450,
        output: s.startsWith("Write") ? [`Wrote ${pv.files[0].path}`] : s === "Reload dekit" ? ["$ dekit -C ~/code reload --yes", `~ ${app.task} (cmd changed)`] : s.startsWith("Wait") ? [`${app.hostname} → ${url}`] : [],
      })),
      result: on ? { kind, url } : { kind },
    });
    const off = ctx.jobs.onChange((j) => {
      if (j.id !== job.id || j.state === "running") return;
      off();
      if (j.state !== "succeeded") return;
      flags.set(id, next);
      ctx.update((ms) => {
        ms.apps = ms.apps.map((a) => (a.id === id && on && a.state !== "on" ? { ...a, state: "on", rawState: "running", port: a.port ?? 4620, url: a.hostname ? proxyUrl(a.hostname, hooks.proxy()) : a.url } : a));
      });
    });
    return job;
  };

  const overview = (): SharingOverview => {
    const shares: SharingOverview["shares"] = [];
    for (const r of [...hooks.routes()]) {
      for (const s of r.shared) {
        const app = r.owner?.kind === "app" && r.owner.appId ? local().apps.find((a) => a.id === r.owner!.appId) : undefined;
        const v = { hostname: r.hostname, kind: s.kind, url: s.url, public: s.kind !== "tailscale", alive: r.alive, owner: r.owner, editable: !!app, reason: undefined as string | undefined };
        if (!app) v.reason = `Started outside Portplane: stop it where it runs (Ctrl+C in its terminal), or start it again without --${s.kind}.`;
        shares.push(v);
      }
    }
    return { os: "linux", providers: providers(), shares };
  };

  // ---- compose ----

  const composeView = (p: ComposeMock): ComposeProject => {
    const routes = p.state === "down" ? [] : composeRoutes().filter((r) => r.compose === p.name);
    return {
      name: p.name,
      label: p.name,
      started: p.state === "running",
      ports: Object.fromEntries(p.services.flatMap((s) => s.ports.filter((x) => x.routed && x.hostPort).map((x) => [`${s.name}:${x.target}`, x.hostPort!]))),
      services: p.state === "down" ? [] : structuredClone(p.services),
      state: p.state,
      file: p.file,
      fileFrom: p.known ? "containers" : "remembered",
      routes: routes.map((r) => ({ hostname: r.hostname, url: r.url, port: r.port, service: p.services.find((s) => composeHostnames({ label: p.name }, s, hooks.tlds()[0]).includes(r.hostname))?.name, listening: p.state === "running" })),
    };
  };
  const composeOverview = (): ComposeOverview => ({
    docker: tools.docker,
    requirements: tools.docker
      ? [req("docker-installed", true, "Docker is installed"), req("docker-compose", true, "Docker Compose is available")]
      : [req("docker-installed", false, "Docker is installed", { problem: "Docker isn't installed, and portless runs compose projects through it.", fix: "Install Docker (Docker Desktop on macOS and Windows, Docker Engine on Linux), then check again.", url: "https://docs.docker.com/get-started/get-docker/" })],
    projects: compose.map(composeView).sort((a, b) => a.name.localeCompare(b.name)),
    tld: hooks.tlds()[0],
  });
  const composePlan = (r: ComposeRequest): ComposePlan => {
    if (r.op !== "up" && r.op !== "down") throw new ApiError(`unknown compose operation "${r.op as string}"`, 400);
    if (r.op === "down" && !r.project) throw new ApiError("name the project to stop", 400);
    if (r.file && !r.file.startsWith("/")) throw new ApiError("give the compose file's full path", 400);
    if (r.file && !/\.(ya?ml)$/.test(r.file) && !compose.some((p) => p.file.startsWith(`${r.file!.replace(/\/$/, "")}/`))) throw new ApiError(`there's no file at ${r.file}`, 400);
    const p = r.project ? compose.find((x) => x.name === r.project) : undefined;
    const file = r.file ? (/\.(ya?ml)$/.test(r.file) ? r.file : `${r.file.replace(/\/$/, "")}/compose.yaml`) : p?.file;
    const name = r.project ?? file?.split("/").slice(-2, -1)[0] ?? "project";
    const dir = file ? file.slice(0, file.lastIndexOf("/")) : "/tmp";
    const args = r.op === "up" ? ["compose", ...(r.project ? ["-p", r.project] : []), ...(file ? ["-f", file] : []), "up", "-d"] : ["compose", "-p", name, ...(file ? ["-f", file] : []), "down"];
    const plan: ComposePlan = {
      op: r.op,
      project: r.project,
      title: `${r.op === "up" ? "Start" : "Stop"} ${name}`,
      summary:
        r.op === "up"
          ? `Starts the project's containers in the background with portless, which gives each service that publishes an HTTP port an address under .${name}. Docker may pull or build images first.`
          : "Stops and removes the project's containers and networks, and their addresses. Volumes and images stay, so starting it again keeps your data.",
      file,
      dir,
      argv: [BIN, ...args],
      terminal: `cd ${dir} && ${BIN} ${args.join(" ")}`,
      warnings: r.op === "up" && !hooks.responding() ? ["The portless proxy isn't running, so portless starts it first. If that needs your password, it can't ask from here and the start fails: start the proxy in Domains → Proxy, then try again."] : [],
    };
    if (!tools.docker) plan.problem = "Docker isn't installed, and portless runs compose projects through it.";
    else if (r.op === "up" && !file) plan.problem = "Portplane can't find this project's compose file. Choose it to start the project.";
    return plan;
  };
  const composeRun = (r: ComposeRequest): Job => {
    const plan = composePlan(r);
    if (plan.problem) throw new ApiError(plan.problem, 400);
    const name = plan.title.replace(/^(Start|Stop) /, "");
    let p = compose.find((x) => x.name === name);
    const output =
      r.op === "up"
        ? [`$ ${plan.terminal}`, "", `portless compose ${name}`, "", ...(name === "shop" ? ["-- db:5432 keeps host port 5432 (not HTTP)", "-- mail:8025 keeps host port 8025 (portless.enable=false)"] : []), "[+] Running 3/3", ` ✔ Network ${name}_default  Created`, ` ✔ Container ${name}-web-1  Started`, "", ...(p?.services ?? [{ name: "web", label: "web", enabled: true, ports: [{ target: 3000, routed: true }] }]).flatMap((s) => composeHostnames({ label: name }, s, hooks.tlds()[0]).map((h) => `  -> ${proxyUrl(h, hooks.proxy())}  (${s.name}:${s.ports.find((x) => x.routed)?.target ?? 0})`))]
        : [`$ ${plan.terminal}`, "[+] Running 3/3", ` ✔ Container ${name}-web-1  Removed`, ` ✔ Network ${name}_default  Removed`];
    const job = ctx.jobs.start({ kind: `portless.compose-${r.op}`, title: plan.title, steps: [{ name: plan.title, ms: r.op === "up" ? 2600 : 1600, output }], result: { project: name, file: plan.file } });
    const off = ctx.jobs.onChange((j) => {
      if (j.id !== job.id || j.state === "running") return;
      off();
      if (j.state !== "succeeded") return;
      if (!p) {
        p = { name, file: plan.file!, state: "running", known: false, names: {}, services: [{ name: "web", label: "web", enabled: true, ports: [{ target: 3000, hostPort: 14020, routed: true }] }] };
        compose.push(p);
      }
      p.state = r.op === "up" ? "running" : "down";
      if (r.op === "down") p.known = false;
    });
    return job;
  };

  // ---- compose names ----

  const composeRoute = (route: string) => {
    for (const p of compose) {
      for (const s of p.services) {
        if (p.state !== "down" && composeHostnames({ label: p.name }, s, hooks.tlds()[0]).includes(route)) return { p, s };
      }
    }
    throw new ApiError(`there's no route ${route} any more`, 400);
  };
  const composeNameInfo = (route: string): NameInfo => {
    need();
    const { p, s } = composeRoute(route);
    const tld = hooks.tlds()[0];
    const taken = [...hooks.routes().map((r) => r.hostname)].filter((h) => h !== route);
    return {
      source: "compose",
      name: s.label,
      inferred: false,
      hostname: route,
      editable: true,
      reason: "",
      file: p.file,
      tld,
      runMode: false,
      compose: p.name,
      service: s.name,
      suffix: `${p.name}.${tld}`,
      route,
      taken,
      notes: s.nameLabel ? [] : [`Portplane adds a portless.name label to the ${s.name} service; the service itself keeps its name.`],
      running: p.state === "running",
      dir: p.file.slice(0, p.file.lastIndexOf("/")),
    };
  };
  const composeFile = (p: ComposeMock, names: Record<string, string>) =>
    `# ${p.name}\nservices:\n${p.services
      .map((s) => `  ${s.name}:\n${s.image ? `    image: ${s.image}\n` : `    build: ./${s.name}\n`}${names[s.name] ? `    labels:\n      portless.name: ${names[s.name]}\n` : ""}${s.ports.length ? `    ports:\n${s.ports.map((x) => `      - "${x.target}:${x.target}"\n`).join("")}` : ""}`)
      .join("")}`;
  const composeNamePreview = (route: string, raw: string): NamePreview => {
    const info = composeNameInfo(route);
    const { p, s } = composeRoute(route);
    const name = raw.trim().toLowerCase().replace(new RegExp(`\\.${info.suffix!.replace(/\./g, "\\.")}$`), "");
    const pv: NamePreview = { name, files: [], steps: [], warnings: [] };
    const problem = composeNameProblem(name);
    pv.hostname = `${name}.${info.suffix}`;
    pv.url = proxyUrl(pv.hostname, hooks.proxy());
    if (problem) return { ...pv, problem };
    if (name === info.name) return { ...pv, problem: "That's the name it has now." };
    const other = p.services.find((x) => x.name !== s.name && x.label === name);
    if (other) return { ...pv, problem: `The ${other.name} service of this project already has that name.` };
    if (info.taken.includes(pv.hostname)) return { ...pv, problem: `${pv.hostname} is already used by another route.` };
    pv.files.push({ path: p.file, before: composeFile(p, p.names), after: composeFile(p, { ...p.names, [s.name]: name }), created: false, changed: true });
    pv.steps.push(`Write ${p.file.split("/").pop()}`);
    if (info.running) pv.steps.push(`Start ${p.name} again with the new name`, "Remove the old address");
    else pv.warnings.push(`${p.name} isn't running: the new name applies the next time it starts.`);
    if (s.ports.filter((x) => x.routed).length > 1) pv.warnings.push(`The service routes several ports, so its <port>.${name}.${info.suffix} addresses change too.`);
    pv.digest = `mock-compose-${route}-${s.label}`;
    return pv;
  };
  const composeRename = (route: string, raw: string, digest: string): Job => {
    const pv = composeNamePreview(route, raw);
    if (pv.problem) throw new ApiError(pv.problem, 400);
    if (digest !== pv.digest) throw new ApiError("the file changed since the preview: review the new preview and apply again", 409);
    const { p, s } = composeRoute(route);
    const job = ctx.jobs.start({
      kind: "portless.rename",
      title: `Rename ${s.name} of ${p.name} to ${pv.hostname}`,
      steps: pv.steps.map((n) => ({ name: n, ms: n.startsWith("Start") ? 2000 : 500, output: n.startsWith("Write") ? [`Wrote ${p.file}`] : n.startsWith("Start") ? [`$ ${BIN} compose -p ${p.name} -f ${p.file} up -d`, `  -> ${pv.url}  (${s.name}:${s.ports[0]?.target ?? 0})`] : [`Removed ${route}`] })),
      result: { hostname: pv.hostname, url: pv.url },
    });
    const off = ctx.jobs.onChange((j) => {
      if (j.id !== job.id || j.state === "running") return;
      off();
      if (j.state !== "succeeded") return;
      p.names[s.name] = pv.name;
      s.label = pv.name;
      s.nameLabel = pv.name;
    });
    return job;
  };

  // ---- LAN ----

  const lan = (): LanView => {
    need();
    const o = hooks.options();
    const addresses = [
      { ip: "192.168.1.20", interface: "wlp2s0", default: true },
      { ip: "10.0.0.5", interface: "enp3s0", default: false },
    ];
    const requirements = tools.avahi
      ? [req("mdns-tool", true, "avahi-publish-address is installed"), req("avahi-daemon", true, "The Avahi service is running"), req("lan-address", true, "This computer is on a network")]
      : [
          req("mdns-tool", false, "avahi-publish-address is installed", { problem: "portless publishes .local names with avahi-publish-address, from the avahi-tools package, which isn't installed.", fix: "Install it, then check again.", command: "sudo dnf install avahi-tools" }),
          req("lan-address", true, "This computer is on a network"),
        ];
    const proxy = hooks.proxy();
    const seen = new Set<string>();
    const apps: LanView["apps"] = [];
    for (const r of hooks.routes()) {
      if (!r.alive || r.kind === "remote" || r.owner?.kind === "portplane") continue;
      const host = `${r.hostname.replace(/\.(localhost|test|local)$/, "")}.local`;
      if (seen.has(host)) continue;
      seen.add(host);
      apps.push({ hostname: host, url: proxyUrl(host, proxy), route: r.hostname, label: r.owner?.label ?? r.hostname, kind: r.kind === "compose" ? "compose" : r.kind === "alias" ? "alias" : "app", machine: r.owner?.machine, appId: r.owner?.appId });
    }
    return {
      os: "linux",
      mdns: { supported: true, tool: "avahi-publish-address", installed: tools.avahi, path: tools.avahi ? "/usr/bin/avahi-publish-address" : undefined, package: "avahi-tools", install: "sudo dnf install avahi-tools" },
      requirements,
      ready: requirements.every((r) => r.ok),
      enabled: o.lan,
      responding: hooks.responding(),
      ip: o.lan ? (o.lanIp ?? addresses[0].ip) : undefined,
      addresses,
      apps,
      options: structuredClone(o),
      serviceInstalled: hooks.serviceInstalled(),
      port: proxy.port,
      https: proxy.https,
      ca: hooks.ca(),
    };
  };

  const operatorPlan = (): Plan => {
    if (tools.tailscale === "missing") throw new ApiError("tailscale isn't installed", 400);
    return {
      action: "tailscale-operator",
      title: "Let dev share with Tailscale",
      summary: "Makes dev Tailscale's operator, so portless can share apps on your tailnet without your password each time. Tailscale keeps this until you change it.",
      admin: true,
      method: "pkexec",
      steps: [{ label: "Let dev share with Tailscale", argv: ["/usr/bin/tailscale", "set", "--operator=dev"], admin: true, terminal: "sudo /usr/bin/tailscale set --operator=dev" }],
    };
  };

  return {
    sharedFor,
    extraRoutes,
    composeNameInfo,
    composeNamePreview,
    composeRename,
    operatorPlan,
    operatorDone: () => (tools.operator = true),
    async portlessSharing() {
      need();
      return ctx.delay(overview(), 450);
    },
    async portlessNgrokAuthtoken(token) {
      need();
      await ctx.delay(undefined, 700);
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(token.trim())) throw new ApiError("that doesn't look like an ngrok authtoken: copy the whole token from the ngrok dashboard", 400);
      if (!tools.ngrok) throw new ApiError("ngrok isn't installed: install it first", 400);
      tools.ngrokToken = true;
      return overview();
    },
    async portlessShareInfo(machine, app) {
      await ctx.delay(undefined, 300);
      return shareInfo(machine, app);
    },
    async portlessSharePreview(machine, app, kind, on) {
      need();
      await ctx.delay(undefined, 250);
      return preview(machine, app, kind, on);
    },
    async portlessShare(machine, app, kind, on, digest, confirmPublic) {
      need();
      await ctx.delay(undefined, 200);
      return share(machine, app, kind, on, digest, confirmPublic);
    },
    async portlessCompose() {
      need();
      return ctx.delay(composeOverview(), 350);
    },
    async portlessComposePreview(r) {
      need();
      await ctx.delay(undefined, 200);
      return composePlan(r);
    },
    async portlessComposeRun(r) {
      need();
      await ctx.delay(undefined, 150);
      return composeRun(r);
    },
    async portlessLan() {
      await ctx.delay(undefined, 300);
      return lan();
    },
  };
}
