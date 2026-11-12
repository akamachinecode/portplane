import { ApiError } from "./errors";
import type { Job } from "./jobs";
import type { MockContext } from "./mockContext";
import type { MockJobStep } from "./mockJobs";
import type {
  CA,
  Certificates,
  ConfigPlace,
  ConfigTarget,
  DoctorReport,
  FileEdit,
  Finding,
  HostCert,
  HostsView,
  NameInfo,
  NamePreview,
  Plan,
  PlanStep,
  PortlessAction,
  PortlessApi,
  PortlessStatus,
  ProjectConfigs,
  ProxyOptions,
  RouteView,
  ServiceStatus,
  StaleRoute,
} from "./portless";
import type { App, MachineSnapshot } from "./types";
import { baseName, checkConfigText, describeOptions, hostnameFor, nameProblem, normalizeOptions, optionsProblems, previewHostname, proxyUrl, renameProblem } from "../lib/portless";

// The in-memory side of portless.ts for `?mock` and tests. Its state
// follows the mock snapshot (apps with names get routes) and every action
// changes it the way portless would, after a fake job.
//
// Besides the shared scenarios, `?mock=broken` shows a portless that needs
// fixing: the proxy down, the service pointing at a Node that is gone, the
// certificate untrusted, stale routes and a hosts file out of date.

const HOME = "/home/dev";
const STATE = `${HOME}/.portless`;
const BIN = `${HOME}/.npm-global/bin/portless`;
const ROOT = `${HOME}/code`;
const FRAGMENT = `${ROOT}/.portplane/tasks.yaml`;
const DEKIT = `${ROOT}/dekit.yaml`;
const USER_ENV = { HOME, PATH: `${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin`, SUDO_USER: "dev", SUDO_UID: "1000", SUDO_GID: "1000" };
const FINGERPRINT = "3F:9A:61:0C:D2:7E:44:B1:58:2C:90:AF:13:6D:E8:05:C7:41:BB:92:0E:7A:D3:66:19:F0:2B:84:5E:C1:A7:3D";

interface Alias {
  hostname: string;
  port: number;
  registeredAt: number;
}

interface ConfigFiles {
  portless?: string;
  pkg: Record<string, unknown>;
}

interface State {
  installed: boolean;
  version: string;
  responding: boolean;
  asRoot: boolean;
  options: ProxyOptions;
  service: { installed: boolean; nodeMissing: boolean };
  ca: CA;
  oldHostCert: boolean;
  aliases: Alias[];
  stale: StaleRoute[];
  hostsBlock: string[];
  configs: Map<string, ConfigFiles>;
  /** Where a renamed app's name lives now: app id → name. */
  names: Map<string, string>;
}

const portplaneRoute = (now: number): Alias => ({ hostname: "portplane.localhost", port: 39001, registeredAt: now - 3 * 3600_000 });

function initialState(scenario: string, now: number): State {
  const installed = !(scenario === "degraded" || scenario === "readonly");
  const broken = scenario === "broken";
  const configs = new Map<string, ConfigFiles>([
    [`${ROOT}/my-monorepo/apps/docs`, { portless: '{\n  "name": "docs.my-monorepo",\n  "script": "dev",\n  "appPort": 4321\n}\n', pkg: { name: "@my-monorepo/docs", private: true, scripts: { dev: "astro dev" } } }],
    [`${ROOT}/my-monorepo-checkout/apps/web`, { pkg: { name: "@my-monorepo/web", private: true, portless: "my-monorepo", scripts: { dev: "next dev" } } }],
  ]);
  return {
    installed,
    version: "0.16.0",
    responding: installed && !broken,
    asRoot: true,
    options: { port: 443, https: true, tlds: broken ? ["localhost", "test"] : ["localhost"], wildcard: false, lan: false, unprivileged: false },
    service: { installed: installed, nodeMissing: broken },
    ca: {
      exists: installed,
      path: `${STATE}/ca.pem`,
      fingerprint: installed ? FINGERPRINT : undefined,
      subject: installed ? "portless Local CA" : undefined,
      notAfter: installed ? "2035-11-10T08:12:00Z" : undefined,
      trusted: installed && !broken,
      systemCopy: installed ? "/etc/pki/ca-trust/source/anchors/portless-ca.crt" : undefined,
      systemCopyNotRoot: broken,
    },
    oldHostCert: broken,
    aliases: scenario === "empty" || scenario === "nofolders" ? [portplaneRoute(now)] : [portplaneRoute(now), { hostname: "ui.my-monorepo.localhost", port: 5173, registeredAt: now - 40 * 60_000 }],
    stale:
      scenario === "default" || broken
        ? [
            { hostname: "old-docs.localhost", port: 4519, pid: 48211, processes: [{ port: 4519, pid: 48230, process: "node" }] },
            ...(broken ? [{ hostname: "storybook.my-monorepo.localhost", port: 4522, pid: 48302, processes: [] }] : []),
          ]
        : [],
    hostsBlock: broken ? ["my-monorepo.test", "old.test"] : [],
    configs,
    names: new Map(),
  };
}

export function createMockPortless(ctx: MockContext): PortlessApi {
  const scenario = String(ctx.scenario);
  const state = initialState(scenario, Date.now());
  // A machine over SSH (ADR-0026): no Portplane alias, no password dialog,
  // and its CA is saved on this computer when exported.
  const method = ctx.remote ? "" : "pkexec";
  if (ctx.remote) {
    state.aliases = [];
    state.stale = [];
    state.configs.clear();
    state.ca.trusted = false;
  }
  const started = Date.now();

  const local = (): MachineSnapshot => ctx.snapshot().machines.find((m) => m.machine.local)!;
  const tlds = () => (state.options.lan ? ["local"] : (state.options.tlds ?? ["localhost"]));
  const proxy = () => ({ port: state.options.port, https: state.options.https });
  const notInstalled = () => new ApiError("portless isn't installed on this computer: install it from Settings → Tools or the welcome screen", 503);
  const need = () => {
    if (!state.installed) throw notInstalled();
  };

  const syncSnapshot = () =>
    ctx.update((ms) => {
      ms.tools.portless = state.installed ? state.version : undefined;
      ms.tools.proxyRunning = state.installed && state.responding;
      ms.tools.proxyHttps = state.options.https;
      ms.tools.proxyPort = state.options.port;
      for (const p of ms.otherPorts) {
        const alias = state.aliases.find((a) => a.port === p.port);
        p.route = alias?.hostname;
        p.url = alias ? proxyUrl(alias.hostname, proxy()) : undefined;
      }
    });

  // ---- routes, as routes.json would hold them ----

  const routes = (): RouteView[] => {
    const ms = local();
    const out: RouteView[] = [];
    const now = Date.now();
    for (const a of ms.apps) {
      if (!a.hostname || a.state !== "on" || !a.port) continue;
      out.push({
        hostname: a.hostname,
        port: a.port,
        pid: a.pid ?? 0,
        registeredAt: started - (a.order + 1) * 7 * 60_000,
        alive: true,
        kind: "app",
        shared: a.task === "my-monorepo/web" ? [{ kind: "tailscale", url: "https://workstation.tail4c2a.ts.net" }] : [],
        url: proxyUrl(a.hostname, proxy()),
        owner: { kind: "app", label: [a.project, a.worktree, a.label].filter(Boolean).join(" · "), machine: ms.machine.id, appId: a.id, pid: a.pid },
      });
    }
    for (const al of state.aliases) {
      const port = ms.otherPorts.find((p) => p.port === al.port);
      out.push({
        hostname: al.hostname,
        port: al.port,
        pid: 0,
        registeredAt: al.registeredAt,
        alive: true,
        kind: "alias",
        shared: [],
        url: proxyUrl(al.hostname, proxy()),
        owner:
          al.hostname === "portplane.localhost"
            ? { kind: "portplane", label: "Portplane" }
            : port
              ? { kind: "process", label: port.process ?? `PID ${port.pid}`, pid: port.pid, process: port.process }
              : undefined,
      });
    }
    for (const m of ctx.snapshot().machines) {
      if (m.machine.local) continue;
      m.apps.forEach((a, i) => {
        if (!a.remoteUrl) return;
        const host = a.remoteUrl.replace(/^https?:\/\//, "").split(/[:/]/)[0];
        out.push({
          hostname: host,
          port: 40100 + i,
          pid: 0,
          registeredAt: started - 20 * 60_000,
          alive: true,
          kind: "remote",
          shared: [],
          url: proxyUrl(host, proxy()),
          owner: { kind: "remote", label: `${[a.project, a.label].join(" · ")} on ${m.machine.name}`, machine: m.machine.id, appId: a.id },
        });
      });
    }
    for (const s of state.stale) {
      const p = s.processes[0];
      out.push({
        hostname: s.hostname,
        port: s.port,
        pid: s.pid,
        registeredAt: now - 26 * 3600_000,
        alive: false,
        kind: "app",
        shared: [],
        url: proxyUrl(s.hostname, proxy()),
        owner: p ? { kind: "process", label: p.process ?? `PID ${p.pid}`, pid: p.pid, process: p.process } : { kind: "process", label: `PID ${s.pid}`, pid: s.pid },
      });
    }
    return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
  };

  // ---- status, certificates, hosts, doctor ----

  const service = (): ServiceStatus | undefined =>
    state.installed
      ? {
          installed: state.service.installed,
          managerState: state.service.installed ? (state.service.nodeMissing ? "failed" : state.responding ? "active" : "inactive") : "not installed",
          responding: state.responding,
          port: state.options.port,
          https: state.options.https,
          tlds: tlds(),
          lan: state.options.lan,
          lanIp: state.options.lanIp,
          wildcard: state.options.wildcard,
          unprivileged: state.options.unprivileged,
          stateDir: STATE,
          entry: "/etc/systemd/system/portless.service",
          nodePath: state.service.installed ? "/home/linuxbrew/.linuxbrew/Cellar/node/24.11.0/bin/node" : undefined,
          nodeMissing: state.service.installed && state.service.nodeMissing,
          parsed: true,
          raw: "",
        }
      : undefined;

  const status = (): PortlessStatus => {
    const base: PortlessStatus = {
      installed: state.installed,
      stateDir: STATE,
      os: "linux",
      proxy: { responding: false, running: false, port: 443, https: true, tlds: ["localhost"], lan: false, unprivileged: false, customCert: false, asRoot: false, configured: false },
      options: { port: 443, https: true, tlds: ["localhost"], wildcard: false, lan: false, unprivileged: false },
      adminToStart: true,
      adminToStop: false,
      method,
      install: { origin: "unknown", bin: "" },
      hostsNeeded: false,
    };
    if (!state.installed) return base;
    const svc = service();
    return {
      ...base,
      version: state.version,
      path: BIN,
      proxy: {
        responding: state.responding,
        running: state.responding,
        port: state.options.port,
        https: state.options.https,
        tlds: tlds(),
        lan: state.options.lan,
        lanIp: state.options.lanIp,
        unprivileged: state.options.unprivileged,
        customCert: !!state.options.certPath,
        pid: state.responding ? 1993 : 48211,
        asRoot: state.responding && state.asRoot,
        configured: true,
      },
      service: svc,
      program: svc?.installed
        ? {
            node: svc.nodePath!,
            script: `${HOME}/.npm-global/lib/node_modules/portless/dist/cli.js`,
            args: ["proxy", "start", "--foreground", "--port", String(state.options.port), state.options.https ? "--https" : "--no-tls"],
            nodeMissing: svc.nodeMissing,
            scriptMissing: false,
          }
        : undefined,
      options: structuredClone(state.options),
      adminToStart: state.options.port < 1024,
      adminToStop: state.responding && state.asRoot,
      install: {
        origin: "npm",
        bin: BIN,
        script: `${HOME}/.npm-global/lib/node_modules/portless/dist/cli.js`,
        prefix: `${HOME}/.npm-global`,
        update: { argv: [`${HOME}/.npm-global/bin/npm`, "install", "--global", "portless@latest"], admin: false },
        uninstall: { argv: [`${HOME}/.npm-global/bin/npm`, "uninstall", "--global", "portless"], admin: false },
      },
      hostsNeeded: tlds().some((t) => t !== "localhost"),
    };
  };

  const hostCerts = (): HostCert[] => {
    const year = Date.now() + 300 * 24 * 3600_000;
    const certs = routes()
      .filter((r) => r.alive)
      .map<HostCert>((r) => ({ file: `${r.hostname.replace(/\./g, "_")}.pem`, names: [r.hostname, `*.${r.hostname}`], notAfter: new Date(year).toISOString(), signedByCa: true }));
    if (state.oldHostCert) certs.push({ file: "blog_localhost.pem", names: ["blog.localhost", "*.blog.localhost"], notAfter: new Date(Date.now() + 9 * 24 * 3600_000).toISOString(), signedByCa: false });
    return certs.sort((a, b) => a.file.localeCompare(b.file));
  };

  const liveHostnames = () => routes().filter((r) => r.alive).map((r) => r.hostname);

  const hosts = (): HostsView => {
    const wanted = liveHostnames().filter((h) => !h.endsWith(".localhost"));
    const needed = tlds().some((t) => t !== "localhost");
    const names = needed ? [...liveHostnames(), ...liveHostnames().map((h) => h.replace(/\.localhost$/, ".test"))] : wanted;
    const block = state.hostsBlock;
    return {
      path: "/etc/hosts",
      readable: true,
      block: block.length > 0,
      entries: block.map((n) => ({ address: "127.0.0.1", names: [n] })),
      missing: names.filter((n) => !block.includes(n)).sort(),
      extra: block.filter((n) => !names.includes(n)).sort(),
      inSync: names.every((n) => block.includes(n)) && block.every((n) => names.includes(n)),
      needed,
      tlds: tlds(),
    };
  };

  const doctor = (): DoctorReport => {
    const f: Finding[] = [];
    const add = (status: Finding["status"], check: string, message: string, extra: Partial<Finding> = {}) => f.push({ status, check, message, ...extra });
    add("ok", "node", "Node.js 24.11.1 satisfies portless requirements.");
    add("ok", "state", `State directory is writable: ${STATE}`, { subject: STATE });
    if (state.responding) {
      add("ok", "proxy", `Proxy is responding on port ${state.options.port}.`);
      add("ok", "pid", "Proxy PID file points to the responding proxy process: 1993");
    } else {
      add("warn", "proxy", `Proxy is not running on port ${state.options.port}.`, { hint: "Run: portless proxy start", fix: "proxy-start" });
      add("warn", "pid", "Proxy PID file is stale: 48211", { hint: "Run: portless proxy stop", fix: "proxy-restart" });
    }
    add("ok", "openssl", "OpenSSL is available for certificate generation.");
    if (state.ca.trusted) add("ok", "ca", "Local CA is trusted by the OS trust store.");
    else add("warn", "ca", "Local CA exists but is not trusted by the OS trust store.", { hint: "Run: portless trust", fix: "trust" });
    const live = routes().filter((r) => r.alive).length;
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    if (state.stale.length) {
      add("warn", "routes", `Routes: ${plural(live, "active route")}, ${plural(state.stale.length, "stale route")}.`, { hint: "Run: portless prune", fix: "prune" });
      for (const s of state.stale) add("warn", "routes", `Stale route ${s.hostname} is owned by exited PID ${s.pid}.`, { fix: "prune", subject: s.hostname });
    } else {
      add("ok", "routes", `Routes: ${plural(live, "active route")}.`);
    }
    const h = hosts();
    if (h.needed && h.missing.length) {
      add("warn", "dns", `${plural(h.missing.length, "hostname")} did not resolve through the system resolver.`, { hint: "Run: portless hosts sync", fix: "hosts-sync" });
      for (const m of h.missing.slice(0, 5)) add("warn", "dns", `${m} is missing from hosts block.`, { fix: "hosts-sync", subject: m });
    } else {
      add("ok", "dns", "Registered hostnames resolve through the system resolver.");
    }
    let failures = 0;
    if (state.service.installed && state.service.nodeMissing) {
      add("fail", "service", "The proxy service starts a program that no longer exists: /home/linuxbrew/.linuxbrew/Cellar/node/24.11.0/bin/node", {
        hint: "Reinstalling the service points it at the Node.js and portless you have now.",
        fix: "service-install",
      });
      failures++;
    }
    return {
      version: state.version,
      node: "24.11.1",
      platform: "linux x64",
      stateDir: STATE,
      proxyTarget: proxyUrl("127.0.0.1", proxy()),
      mode: `${state.options.https ? "HTTPS" : "HTTP"}, ${tlds().map((t) => `.${t}`).join(", ")}`,
      findings: f,
      failures,
      warnings: f.filter((x) => x.status === "warn").length,
      parsed: true,
      raw: f.map((x) => `${x.status.padEnd(5)} ${x.message}`).join("\n"),
    };
  };

  // ---- plans and jobs ----

  const terminal = (argv: string[], env?: Record<string, string>) => {
    const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
    if (!env) return argv.map(q).join(" ");
    const vars = Object.entries(env)
      .filter(([k]) => !["PATH", "SUDO_USER", "SUDO_UID", "SUDO_GID"].includes(k))
      .map(([k, v]) => q(`${k}=${v}`));
    return ["sudo", ...(vars.length ? ["env", ...vars] : []), ...argv.map(q)].join(" ");
  };
  const portlessStep = (label: string, admin: boolean, ...args: string[]): PlanStep => {
    const argv = [BIN, ...args];
    return admin ? { label, argv, env: USER_ENV, admin: true, terminal: terminal(argv, USER_ENV) } : { label, argv, admin: false, terminal: terminal(argv) };
  };
  const optionArgs = (o: ProxyOptions) => {
    const a = ["--port", String(o.port)];
    if (o.https && o.certPath) a.push("--cert", o.certPath, "--key", o.keyPath ?? "");
    else a.push(o.https ? "--https" : "--no-tls");
    if (o.lan) {
      a.push("--lan");
      if (o.lanIp) a.push("--ip", o.lanIp);
    } else {
      const t = o.tlds ?? ["localhost"];
      if (t.length > 1 || t[0] !== "localhost") for (const x of t) a.push("--tld", x);
    }
    if (o.wildcard) a.push("--wildcard");
    if (o.unprivileged) a.push("--unprivileged");
    return a;
  };

  const plan = (action: PortlessAction, opts?: ProxyOptions): Plan => {
    if (!state.installed) throw notInstalled();
    const o = normalizeOptions(opts ?? state.options);
    const bad = Object.values(optionsProblems(o))[0];
    if (opts && bad) throw new ApiError(bad, 400);
    const p: Plan = { action, title: "", summary: "", admin: false, steps: [], method };
    const restart = () => {
      if (state.service.installed) p.steps.push(portlessStep("Restart the proxy service", true, "service", "install", ...optionArgs(o)));
      else {
        if (state.responding) p.steps.push(portlessStep("Stop the proxy", state.asRoot, "proxy", "stop", "--port", String(state.options.port)));
        p.steps.push(portlessStep("Start the proxy", o.port < 1024, "proxy", "start", ...optionArgs(o)));
      }
    };
    switch (action) {
      case "proxy-start":
        p.title = "Start the proxy";
        p.summary = `Starts the portless proxy on ${describeOptions(o)}. It runs until you stop it or restart the computer; the proxy service starts it with the computer instead.`;
        p.steps.push(portlessStep("Start the proxy", o.port < 1024, "proxy", "start", ...optionArgs(o)));
        break;
      case "proxy-stop":
        p.title = "Stop the proxy";
        p.summary = "Stops the portless proxy. Your apps keep running, but their .localhost addresses stop loading until it starts again.";
        if (state.service.installed) p.notes = ["The proxy service starts it again the next time the computer starts."];
        p.steps.push(portlessStep("Stop the proxy", state.asRoot, "proxy", "stop", "--port", String(state.options.port)));
        break;
      case "proxy-restart":
        p.title = "Restart the proxy";
        p.summary = `Stops the portless proxy and starts it again on ${describeOptions(o)}.`;
        restart();
        break;
      case "service-install":
        p.title = state.service.installed ? "Reinstall the proxy service" : "Install the proxy service";
        p.summary = state.service.installed
          ? `Installs the proxy service again, on ${describeOptions(o)}, and restarts the proxy. portless keeps the proxy's options in its service, so changing them means reinstalling it.`
          : `Installs a service that starts the portless proxy on ${describeOptions(o)} whenever the computer starts, so your .localhost addresses always work.`;
        p.steps.push(portlessStep(p.title, true, "service", "install", ...optionArgs(o)));
        break;
      case "service-uninstall":
        p.title = "Remove the proxy service";
        p.summary = "Stops the proxy and removes its startup service. You can still start the proxy by hand from this page.";
        p.steps.push(portlessStep("Remove the proxy service", true, "service", "uninstall"));
        break;
      case "trust":
        p.title = "Trust the local certificate";
        p.summary = "Adds portless's local certificate authority to your system's trusted certificates, so browsers show the padlock for your .localhost addresses. portless creates it first if it doesn't exist.";
        p.steps.push(portlessStep("Trust the local certificate", true, "trust"));
        break;
      case "ca-regenerate":
        p.title = "Regenerate the local certificate";
        p.summary = "Replaces portless's local certificate authority with a new one and trusts it. Browsers and devices that trusted the old one by hand (a phone, another computer) must trust the new one again.";
        p.steps.push({ label: "Move the current certificate aside", admin: false });
        p.steps.push(portlessStep("Create and trust a new certificate", true, "trust"));
        if (state.responding) restart();
        p.notes = [`Nothing is deleted: the old files move to a ca-backup folder in ${STATE}.`];
        break;
      case "ca-fix-ownership":
        if (!state.ca.systemCopyNotRoot) throw new ApiError("the system's copy of the certificate already belongs to the administrator", 400);
        p.title = "Give the trusted certificate back to the administrator";
        p.summary = "The copy of the certificate your system trusts belongs to your user, so any program you run could replace it with another one. This makes the administrator its owner again.";
        p.steps.push({ label: "Fix the certificate's owner", argv: ["/usr/bin/chown", "root:root", state.ca.systemCopy!], admin: true, terminal: `sudo /usr/bin/chown root:root ${state.ca.systemCopy}` });
        break;
      case "hosts-sync":
        p.title = "Sync the hosts file";
        p.summary = "Writes every route's hostname into portless's block of /etc/hosts, so the system finds them for domains other than .localhost.";
        p.steps.push(portlessStep(p.title, true, "hosts", "sync"));
        break;
      case "hosts-clean":
        p.title = "Clean the hosts file";
        p.summary = "Removes portless's block from /etc/hosts. Nothing else in the file changes.";
        p.steps.push(portlessStep(p.title, true, "hosts", "clean"));
        break;
      case "prune":
        p.title = "Clean stale routes";
        p.summary = "Removes routes whose portless process is gone, and asks the dev servers still holding their ports to stop (SIGTERM).";
        p.steps.push(portlessStep(p.title, false, "prune"));
        break;
      case "prune-force":
        p.title = "Force-stop orphaned servers";
        p.summary = "Removes routes whose portless process is gone and kills the dev servers still holding their ports at once (SIGKILL). Unsaved work in those servers is lost.";
        p.steps.push(portlessStep(p.title, false, "prune", "--force"));
        break;
      case "update":
        p.title = "Update portless";
        p.summary = "Updates portless to its latest version with npm.";
        p.steps.push({ label: "Update portless", argv: [`${HOME}/.npm-global/bin/npm`, "install", "--global", "portless@latest"], admin: false, terminal: `${HOME}/.npm-global/bin/npm install --global portless@latest` });
        p.steps.push({ label: "Check the new version", admin: false });
        if (state.service.installed) p.steps.push({ ...portlessStep("Reinstall the proxy service", true, "service", "install", ...optionArgs(state.options)), when: "Only if the service still starts the old version (its Node.js or portless files are gone or moved)." });
        break;
      case "uninstall":
        p.title = "Uninstall portless";
        p.summary = "Cleans up everything portless set up on this computer, then removes the portless program. Your apps, dekit.yaml and portless.json files stay as they are; apps lose their .localhost addresses.";
        p.notes = [
          "Stops the proxy and removes its startup service, if installed.",
          "Removes portless's local certificate authority from your system's trusted certificates.",
          `Deletes portless's files in ${STATE}: routes, proxy settings and certificates.`,
          "Removes portless's block from /etc/hosts.",
          "Removes the portless program with npm.",
        ];
        p.steps.push(portlessStep("Clean up portless", true, "clean"));
        p.steps.push({ label: "Remove the portless program", argv: [`${HOME}/.npm-global/bin/npm`, "uninstall", "--global", "portless"], admin: false, terminal: `${HOME}/.npm-global/bin/npm uninstall --global portless` });
        break;
      default:
        throw new ApiError(`unknown portless action "${action as string}"`, 400);
    }
    p.admin = p.steps.some((s) => s.admin);
    return p;
  };

  /** Runs a plan as a fake job; apply changes the state once it succeeds. */
  const runJob = (p: Plan, kind: string, apply: () => void, output: (s: PlanStep, i: number) => string[] = () => [], result?: unknown): Job => {
    const steps: MockJobStep[] = p.steps.map((s, i) => ({
      name: s.label,
      ms: s.admin ? 1400 : 700,
      output: [...(s.terminal ? [`$ ${s.terminal}`] : []), ...output(s, i)],
    }));
    const job = ctx.jobs.start({ kind, title: p.title, steps, privileged: p.admin, result });
    const off = ctx.jobs.onChange((j) => {
      if (j.id !== job.id || j.state === "running") return;
      off();
      if (j.state === "succeeded") {
        apply();
        syncSnapshot();
      }
    });
    return job;
  };

  const actionOutput: Partial<Record<PortlessAction, string[]>> = {
    "proxy-start": ["HTTPS/2 proxy started on port 443"],
    "proxy-stop": ["Proxy stopped."],
    "proxy-restart": ["Restarted portless.service", "Proxy is responding on port 443."],
    "service-install": ["Wrote /etc/systemd/system/portless.service", "Reloaded systemd", "Started portless.service", "Proxy is responding on port 443."],
    "service-uninstall": ["Stopped portless.service", "Removed /etc/systemd/system/portless.service"],
    trust: ["Local CA added to system trust store.", "Browsers will now trust portless HTTPS certificates."],
    "hosts-sync": ["Synced 3 hostname(s) to /etc/hosts:"],
    "hosts-clean": ["Removed portless entries from /etc/hosts."],
    update: ["changed 1 package in 3s", "portless 0.16.0 → 0.16.1"],
    uninstall: ["Removed startup service.", "Stopping proxy if it is running...", "Removed local CA from the system trust store.", "Removed portless state files from known state directories.", "Clean finished.", "removed 1 package in 1s"],
  };

  const run = (action: PortlessAction, opts?: ProxyOptions): Job => {
    const p = plan(action, opts);
    const o = normalizeOptions(opts ?? state.options);
    const out = (s: PlanStep) => (s.label === "Move the current certificate aside" ? [`Moved the old certificate and the certificates it signed to ${STATE}/ca-backup-20261112-093000`] : (actionOutput[action] ?? ["ok"]));
    switch (action) {
      case "proxy-start":
        return runJob(p, `portless.${action}`, () => {
          state.options = o;
          state.responding = true;
          state.asRoot = o.port < 1024;
        }, out);
      case "proxy-stop":
        return runJob(p, `portless.${action}`, () => (state.responding = false), out);
      case "proxy-restart":
      case "service-install":
        return runJob(p, `portless.${action}`, () => {
          state.options = o;
          state.responding = true;
          state.asRoot = true;
          if (action === "service-install") state.service = { installed: true, nodeMissing: false };
        }, out);
      case "service-uninstall":
        return runJob(p, `portless.${action}`, () => {
          state.service.installed = false;
          state.responding = false;
        }, out);
      case "trust":
        return runJob(p, `portless.${action}`, () => (state.ca = { ...state.ca, exists: true, trusted: true }), out);
      case "ca-regenerate":
        return runJob(p, `portless.${action}`, () => {
          state.ca = { ...state.ca, exists: true, trusted: true, fingerprint: FINGERPRINT.split(":").reverse().join(":"), notAfter: "2036-11-12T09:30:00Z" };
          state.oldHostCert = false;
        }, out);
      case "ca-fix-ownership":
        return runJob(p, `portless.${action}`, () => (state.ca = { ...state.ca, systemCopyNotRoot: false }), () => []);
      case "hosts-sync":
        return runJob(p, `portless.${action}`, () => {
          const h = hosts();
          state.hostsBlock = [...state.hostsBlock.filter((n) => !h.extra.includes(n)), ...h.missing];
        }, out);
      case "hosts-clean":
        return runJob(p, `portless.${action}`, () => (state.hostsBlock = []), out);
      case "prune":
      case "prune-force": {
        const signal = action === "prune-force" ? "SIGKILL" : "SIGTERM";
        const lines = state.stale.flatMap((s) =>
          s.processes.length ? s.processes.map((x) => `  ${s.hostname} :${s.port} - killed PID ${x.pid} (${signal})`) : [`  ${s.hostname} :${s.port} - route removed (port already free)`],
        );
        const killed = state.stale.reduce((n, s) => n + s.processes.length, 0);
        const summary = state.stale.length ? `Pruned ${state.stale.length} stale route${state.stale.length === 1 ? "" : "s"}, killed ${killed} orphaned process${killed === 1 ? "" : "es"}.` : "No orphaned routes found.";
        const result = {
          routes: state.stale.length,
          killed,
          parsed: true,
          lines: state.stale.flatMap((s) => (s.processes.length ? s.processes.map((x) => ({ hostname: s.hostname, port: s.port, pid: x.pid, action: "killed", signal })) : [{ hostname: s.hostname, port: s.port, action: "removed" }])),
        };
        return runJob(p, `portless.${action}`, () => (state.stale = []), () => [...lines, summary], result);
      }
      case "update":
        return runJob(p, "portless.update", () => (state.version = "0.16.1"), (s) => (s.label === "Check the new version" ? ["portless 0.16.0 → 0.16.1"] : s.label === "Update portless" ? ["changed 1 package in 3s"] : ["Wrote /etc/systemd/system/portless.service"]), { before: "0.16.0", after: "0.16.1" });
      case "uninstall":
        return runJob(p, "portless.uninstall", () => {
          state.installed = false;
          state.responding = false;
          state.service.installed = false;
          state.ca = { exists: false, path: `${STATE}/ca.pem`, trusted: false };
          state.aliases = [];
          state.stale = [];
        }, out);
    }
  };

  // ---- names ----

  const appById = (machine: string, id: string): { app: App; ms: MachineSnapshot } => {
    const ms = local();
    if (machine && machine !== ms.machine.id) throw new ApiError("names of apps on other machines can be changed on that machine for now; remote machines get this later", 400);
    const app = ms.apps.find((a) => a.id === id);
    if (!app) throw new ApiError(`unknown app "${id}"`, 400);
    return { app, ms };
  };

  const nameInfo = (machine: string, id: string): NameInfo => {
    need();
    const { app, ms } = appById(machine, id);
    const tld = tlds()[0];
    const taken = [...new Set([...ms.apps.filter((a) => a.id !== app.id && a.hostname).map((a) => a.hostname!), ...routes().map((r) => r.hostname).filter((h) => h !== app.hostname)])].sort();
    const info: NameInfo = { source: "none", name: "", inferred: false, hostname: app.hostname ?? "", editable: false, reason: "", tld, runMode: false, taken, notes: [], running: ["on", "starting", "stopping"].includes(app.state), dir: app.dir };
    if (!app.hostname) {
      info.reason = "This app doesn't run through portless, so it has no name to change. Wrap its command with portless <name> to give it one.";
      return info;
    }
    const named = app.command && app.command[0] === "portless" && app.command[1] !== "run" ? app.command[1] : undefined;
    if (app.task === "blog/studio") {
      return { ...info, source: "task", name: "studio.blog", file: DEKIT, task: app.task, reason: "This task's command is written in a way Portplane won't rewrite (a !js value, an anchor, or a name inside a longer string). Open dekit.yaml in your editor to change it." };
    }
    if (named || app.task === "blog/site") {
      const fragment = app.task !== "my-monorepo/api" && app.task !== "blog/site";
      return {
        ...info,
        source: fragment ? "fragment" : "task",
        name: state.names.get(app.id) ?? named ?? baseName(app.hostname, [tld]),
        file: fragment ? FRAGMENT : DEKIT,
        task: app.task,
        editable: true,
        notes: fragment ? [] : ["Portplane changes only this task's lines in dekit.yaml; the preview shows exactly what changes."],
      };
    }
    const dir = app.dir ?? ROOT;
    const cfg = state.configs.get(dir);
    const fromConfig = cfg?.portless ? checkConfigText(cfg.portless).config?.name : typeof cfg?.pkg.portless === "string" ? cfg.pkg.portless : undefined;
    const prefix = app.worktree || undefined;
    return {
      ...info,
      source: "config",
      runMode: true,
      prefix,
      dir,
      target: cfg?.portless ? "portless.json" : typeof cfg?.pkg.portless !== "undefined" ? "package.json" : "portless.json",
      name: state.names.get(app.id) ?? fromConfig ?? baseName(app.hostname, [tld]).replace(prefix ? `${prefix}.` : "", ""),
      inferred: !fromConfig && !state.names.has(app.id),
      editable: true,
      notes: [],
    };
  };

  const fileFor = (info: NameInfo, app: App, name: string): FileEdit => {
    if (info.source === "config") {
      const dir = info.dir!;
      const cfg = state.configs.get(dir) ?? { pkg: { name: `@my-monorepo/${app.label}` } };
      if (info.target === "package.json") {
        const before = JSON.stringify(cfg.pkg, null, 2) + "\n";
        const after = JSON.stringify({ ...cfg.pkg, portless: typeof cfg.pkg.portless === "string" ? name : { ...(cfg.pkg.portless as object), name } }, null, 2) + "\n";
        return { path: `${dir}/package.json`, before, after, created: false, changed: true };
      }
      const before = cfg.portless ?? "";
      const parsed = (before ? JSON.parse(before) : {}) as Record<string, unknown>;
      return { path: `${dir}/portless.json`, before, after: JSON.stringify({ ...parsed, name }, null, 2) + "\n", created: !before, changed: true };
    }
    const file = info.file!;
    const cmd = (n: string) => (info.source === "fragment" ? `["portless", "${n}", "pnpm", "run", "dev"]` : `[portless, ${n}, pnpm, run, dev]`);
    const block = (n: string) =>
      info.source === "fragment"
        ? `# Generated by Portplane (https://github.com/akamachinecode/portplane).\n# Every scan rewrites this file and keeps the portless names you change here.\ntasks:\n  ${app.task}:\n    label: "${app.label}"\n    cwd: "../${(app.dir ?? "").replace(`${ROOT}/`, "")}"\n    cmd: ${cmd(n)}\n    deps: ["my-monorepo/install"]\n    env: {AI_AGENT: null, CLAUDECODE: null}\n`
        : `# dekit project: https://dekit.run\nload:\n  - .portplane/tasks.yaml\n\ntasks:\n  # the API talks to the database on 5432\n  ${app.task}:\n    cwd: ${(app.dir ?? "").replace(`${ROOT}/`, "")}\n    cmd: ${cmd(n)}\n    env:\n      DATABASE_URL: postgres://localhost:5432/dev\n`;
    return { path: file, before: block(info.name), after: block(name), created: false, changed: true };
  };

  const preview = (machine: string, id: string, raw: string): NamePreview => {
    const info = nameInfo(machine, id);
    const { app } = appById(machine, id);
    const name = raw.trim().toLowerCase().replace(new RegExp(`\\.${info.tld}$`), "");
    const pv: NamePreview = { name, files: [], steps: [], warnings: [] };
    if (!info.editable) return { ...pv, problem: info.reason };
    const problem = nameProblem(name, info.tld) ?? renameProblem(info, name);
    pv.hostname = previewHostname(info, name);
    pv.url = proxyUrl(pv.hostname, proxy());
    if (problem) return { ...pv, problem };
    if (name.includes(".")) pv.warnings.push(`A name with a dot is a subdomain of ${name.slice(name.indexOf(".") + 1)}.${info.tld}. Apps on sibling subdomains share a login only when the cookie domain is that parent, and services with a CORS allowlist need the new origin.`);
    const file = fileFor(info, app, name);
    pv.files.push(file);
    const fileName = file.path.split("/").pop()!;
    pv.steps.push(`Write ${fileName}`);
    if (info.source !== "config") pv.steps.push("Reload dekit");
    if (info.running) pv.steps.push(`Restart ${app.label}`);
    if (info.source === "config" && info.prefix) pv.warnings.push(`portless run puts this checkout's worktree name in front: the address is ${pv.hostname}.`);
    pv.digest = `mock-${app.id}-${info.name}`;
    return pv;
  };

  const rename = (machine: string, id: string, raw: string, digest: string): Job => {
    const pv = preview(machine, id, raw);
    if (pv.problem) throw new ApiError(pv.problem, 400);
    if (digest !== pv.digest) throw new ApiError("the file changed since the preview: review the new preview and apply again", 409);
    const info = nameInfo(machine, id);
    const { app } = appById(machine, id);
    const job = ctx.jobs.start({
      kind: "portless.rename",
      title: `Rename ${app.label} to ${pv.hostname}`,
      steps: pv.steps.map((name) => ({ name, ms: name.startsWith("Restart") ? 1500 : 500, output: name.startsWith("Write") ? [`Wrote ${pv.files[0].path}`] : name === "Reload dekit" ? ["$ dekit -C ~/code reload --yes", "~ " + app.task + " (cmd changed)"] : [] })),
      result: { hostname: pv.hostname, url: pv.url },
    });
    const off = ctx.jobs.onChange((j) => {
      if (j.id !== job.id || j.state === "running") return;
      off();
      if (j.state !== "succeeded") return;
      state.names.set(app.id, pv.name);
      if (info.source === "config") {
        const dir = info.dir!;
        const cfg = state.configs.get(dir) ?? { pkg: { name: `@my-monorepo/${app.label}` } };
        if (info.target === "package.json") cfg.pkg = JSON.parse(pv.files[0].after) as Record<string, unknown>;
        else cfg.portless = pv.files[0].after;
        state.configs.set(dir, cfg);
      }
      ctx.update((ms) => {
        ms.apps = ms.apps.map((a) =>
          a.id === app.id
            ? {
                ...a,
                hostname: pv.hostname,
                url: a.url ? pv.url : undefined,
                command: a.command && a.command[0] === "portless" && a.command[1] !== "run" ? [a.command[0], pv.name, ...a.command.slice(2)] : a.command,
              }
            : a,
        );
      });
    });
    return job;
  };

  // ---- portless.json ----

  const configsOf = (dir: string): ProjectConfigs => {
    if (!dir.startsWith(`${ROOT}/`) && dir !== ROOT) throw new ApiError("only portless config inside the folders Portplane watches can be edited here", 400);
    const cfg = state.configs.get(dir) ?? { pkg: {} };
    const pkgText = JSON.stringify(cfg.pkg, null, 2) + "\n";
    const portless = cfg.portless !== undefined ? checkConfigText(cfg.portless) : null;
    const hasKey = "portless" in cfg.pkg;
    const pkgCheck = hasKey ? checkConfigText(JSON.stringify(cfg.pkg.portless)) : null;
    return {
      dir,
      portless: {
        path: `${dir}/portless.json`,
        exists: cfg.portless !== undefined,
        hasConfig: cfg.portless !== undefined,
        text: cfg.portless,
        config: portless?.config ?? undefined,
        problems: portless?.problems ?? [],
        warnings: portless?.warnings ?? [],
        digest: cfg.portless !== undefined ? `d-${cfg.portless.length}` : undefined,
      },
      package: {
        path: `${dir}/package.json`,
        exists: Object.keys(cfg.pkg).length > 0,
        hasConfig: hasKey,
        text: hasKey ? JSON.stringify(cfg.pkg.portless, null, 2) : undefined,
        config: pkgCheck?.config ?? undefined,
        problems: pkgCheck?.problems ?? [],
        warnings: pkgCheck?.warnings ?? [],
        digest: Object.keys(cfg.pkg).length ? `d-${pkgText.length}` : undefined,
      },
      wins: cfg.portless !== undefined ? "portless.json" : hasKey ? "package.json" : "",
      packageName: typeof cfg.pkg.name === "string" ? cfg.pkg.name : undefined,
    };
  };

  const configEdit = (dir: string, target: ConfigTarget, text: string): FileEdit => {
    const cfg = state.configs.get(dir) ?? { pkg: {} };
    if (target === "portless.json") {
      const before = cfg.portless ?? "";
      return { path: `${dir}/portless.json`, before, after: text.trimEnd() + "\n", created: cfg.portless === undefined, changed: before !== text.trimEnd() + "\n" };
    }
    if (!Object.keys(cfg.pkg).length) throw new ApiError("this folder has no package.json", 400);
    const before = JSON.stringify(cfg.pkg, null, 2) + "\n";
    const after = JSON.stringify({ ...cfg.pkg, portless: JSON.parse(text) as unknown }, null, 2) + "\n";
    return { path: `${dir}/package.json`, before, after, created: false, changed: before !== after };
  };

  const places = (): ConfigPlace[] => {
    const ms = local();
    const out = new Map<string, ConfigPlace>();
    for (const [dir] of state.configs) out.set(dir, { dir, wins: configsOf(dir).wins, apps: [] });
    for (const a of ms.apps) {
      const p = out.get(a.dir ?? "");
      if (p) p.apps.push({ id: a.id, label: a.label, project: a.project, runMode: !a.command });
    }
    return [...out.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  };

  // The broken scenario's proxy is down: the snapshot says so too.
  if (scenario === "broken") syncSnapshot();

  return {
    portlessStatus: () => ctx.delay(status(), 250),
    async portlessDoctor() {
      need();
      return ctx.delay(doctor(), 1100);
    },
    async portlessRoutes() {
      need();
      return ctx.delay(routes(), 200);
    },
    async portlessPrunePreview() {
      need();
      return ctx.delay(structuredClone(state.stale), 200);
    },
    async portlessAddAlias(req) {
      need();
      await ctx.delay(undefined, 400);
      const tld = tlds()[0];
      const problem = nameProblem(req.name, tld);
      if (problem) throw new ApiError(problem, 400);
      if (req.port < 1 || req.port > 65535) throw new ApiError("pick a port between 1 and 65535", 400);
      const host = hostnameFor(req.name, tld);
      if (host === "portplane.localhost") throw new ApiError("portplane.localhost is Portplane's own address", 400);
      const holder = routes().find((r) => r.hostname === host);
      if (holder && !req.force) {
        throw new ApiError(
          holder.kind === "alias"
            ? "another alias already uses that name: pick another, or turn on “Replace the existing route”"
            : "a running app already uses that name: pick another, or turn on “Replace the existing route” to take it over (that app's portless process is stopped)",
          409,
        );
      }
      state.aliases = [...state.aliases.filter((a) => a.hostname !== host), { hostname: host, port: req.port, registeredAt: Date.now() }];
      syncSnapshot();
      return routes();
    },
    async portlessReplaceAlias(req) {
      need();
      await ctx.delay(undefined, 400);
      const tld = tlds()[0];
      const problem = nameProblem(req.name, tld);
      if (problem) throw new ApiError(problem, 400);
      const host = hostnameFor(req.name, tld);
      const holder = routes().find((r) => r.hostname === host && r.hostname !== req.from);
      if (holder && !req.force) throw new ApiError("another route already uses that name: pick another, or turn on “Replace the existing route”", 409);
      state.aliases = [...state.aliases.filter((a) => a.hostname !== req.from && a.hostname !== host), { hostname: host, port: req.port, registeredAt: Date.now() }];
      syncSnapshot();
      return routes();
    },
    async portlessRemoveAlias(hostname) {
      need();
      await ctx.delay(undefined, 300);
      if (hostname === "portplane.localhost") throw new ApiError("portplane.localhost is Portplane's own address; it goes away when Portplane quits", 400);
      if (!state.aliases.some((a) => a.hostname === hostname)) throw new ApiError("there is no alias with that name any more", 404);
      state.aliases = state.aliases.filter((a) => a.hostname !== hostname);
      syncSnapshot();
      return routes();
    },
    async portlessCertificates() {
      need();
      const c: Certificates = { ca: structuredClone(state.ca), hostCerts: hostCerts(), os: "linux", method, trustNeedsAdmin: true };
      return ctx.delay(c, 250);
    },
    async portlessExportCA() {
      need();
      if (!state.ca.exists) throw new ApiError("portless has no certificate yet: start the proxy with HTTPS or trust it first", 400);
      return ctx.delay({ path: `${HOME}/Downloads/${ctx.remote ? `portless-ca-${ctx.remote.id}` : "portless-ca"}.pem`, revealed: true }, 300);
    },
    async portlessHosts() {
      need();
      return ctx.delay(hosts(), 200);
    },
    async portlessPlan(action, options) {
      await ctx.delay(undefined, 250);
      return plan(action, options);
    },
    async portlessRun(action, options) {
      await ctx.delay(undefined, 150);
      return run(action, options);
    },
    async portlessNameInfo(machine, app) {
      await ctx.delay(undefined, 200);
      return nameInfo(machine, app);
    },
    async portlessNamePreview(machine, app, name) {
      need();
      await ctx.delay(undefined, 220);
      return preview(machine, app, name);
    },
    async portlessRename(machine, app, name, digest) {
      need();
      await ctx.delay(undefined, 200);
      return rename(machine, app, name, digest);
    },
    portlessConfigs: () => ctx.delay(places(), 200),
    async portlessConfig(dir) {
      await ctx.delay(undefined, 200);
      return configsOf(dir);
    },
    async portlessConfigPreview(dir, target, text) {
      await ctx.delay(undefined, 150);
      configsOf(dir);
      const check = checkConfigText(text);
      if (check.problems.length) return { problems: check.problems, warnings: check.warnings };
      return { edit: configEdit(dir, target, text), problems: [], warnings: check.warnings };
    },
    async portlessConfigSave(dir, target, text, digest) {
      await ctx.delay(undefined, 300);
      const cur = configsOf(dir);
      const want = target === "portless.json" ? (cur.portless.digest ?? "") : (cur.package.digest ?? "");
      if (digest !== want) throw new ApiError("the file changed since Portplane read it: review the new version and try again", 409);
      const check = checkConfigText(text);
      if (check.problems.length) throw new ApiError(check.problems[0], 400);
      const edit = configEdit(dir, target, text);
      const cfg = state.configs.get(dir) ?? { pkg: {} };
      if (target === "portless.json") cfg.portless = edit.after;
      else cfg.pkg = JSON.parse(edit.after) as Record<string, unknown>;
      state.configs.set(dir, cfg);
      return configsOf(dir);
    },
  };
}
