import { ApiError } from "./errors";
import type { Job } from "./jobs";
import type { MockContext } from "./mockContext";
import type { MockJobSpec } from "./mockJobs";
import type {
  BrowserProfile,
  BrowserReport,
  CommandPreview,
  FolderSuggestion,
  InstallPlan,
  PathStatus,
  ProxyOptions,
  ProxyResult,
  ToolId,
  ToolOrigin,
  ToolsApi,
} from "./tools";
import { NO_PASSWORD_PROXY } from "./tools";
import type { Requirement, RequirementId, SetupCheck } from "./types";

// The in-memory side of tools.ts for `?mock` and tests: a small model of
// the machine (which tools are there, the proxy, the CA, the browsers) that
// installs and the proxy steps change, with jobs that print what the real
// ones print. Scenarios (see mock.ts):
//   fresh       nothing installed, no Node.js
//   node20      Node.js 20 (too old) with mise, no dekit or portless, no certutil
//   nopassword  tools installed, no proxy, and no password dialog on this machine
// Every other scenario starts with the tools installed (portless missing in
// degraded; neither tool in readonly).

const HOME = "/home/dev";
const BIN = `${HOME}/.local/bin`;
const DATA = `${HOME}/.local/share/portplane`;

interface Profile {
  id: string;
  name: string;
  dir: string;
  /** Keeps its own certificates (a snap, or NSS without p11-kit). */
  own: boolean;
  inDb: boolean;
  default?: boolean;
}

interface MockBrowser {
  id: "firefox" | "chrome";
  variant?: "snap";
  name: string;
  profiles: Profile[];
}

export interface MachineModel {
  dekit?: { version: string; origin: ToolOrigin["kind"] };
  /** The user's Node on PATH, and Portplane's private one. */
  node?: string;
  privateNode?: string;
  managers: string[]; // mise, fnm, volta
  portless?: { version: string; origin: ToolOrigin["kind"] };
  proxy: "none" | "service" | "unprivileged";
  caExists: boolean;
  caTrusted: boolean;
  certutil: boolean;
  browsers: MockBrowser[];
  onPath: boolean;
  /** A password dialog can open (pkexec here). */
  dialog: boolean;
  /** Something else on port 443. */
  port443?: { pid: number; process: string };
  git?: string;
  packageManagers: Record<string, string>;
}

function browsers(): MockBrowser[] {
  return [
    {
      id: "firefox",
      name: "Firefox",
      profiles: [
        { id: "firefox:7c1e09a4b2f3", name: "default-release", dir: `${HOME}/.mozilla/firefox/abc.default-release`, own: true, inDb: false, default: true },
        { id: "firefox:0d5a38e1c962", name: "work", dir: `${HOME}/.mozilla/firefox/def.work`, own: true, inDb: false },
      ],
    },
    { id: "chrome", name: "Chrome", profiles: [{ id: "chrome:4f02be1d9a77", name: "All profiles", dir: `${HOME}/.pki/nssdb`, own: true, inDb: false, default: true }] },
  ];
}

/** The machine a scenario starts with. */
export function machineFor(scenario: string): MachineModel {
  const ready: MachineModel = {
    dekit: { version: "0.10.3", origin: "script" },
    node: "v24.11.0",
    managers: ["mise"],
    portless: { version: "0.16.0", origin: "npm" },
    proxy: "service",
    caExists: true,
    caTrusted: true,
    certutil: true,
    browsers: browsers().map((b) => ({ ...b, profiles: b.profiles.map((p) => ({ ...p, inDb: true })) })),
    onPath: true,
    dialog: true,
    git: "2.47.1",
    packageManagers: { npm: "10.9.2", pnpm: "10.4.1", yarn: "", bun: "" },
  };
  switch (scenario) {
    case "fresh":
      return { managers: [], proxy: "none", caExists: false, caTrusted: false, certutil: true, browsers: browsers(), onPath: false, dialog: true, git: "2.43.0", packageManagers: { npm: "", pnpm: "", yarn: "", bun: "" } };
    case "node20":
      return { ...ready, dekit: undefined, portless: undefined, node: "v20.11.1", proxy: "none", caExists: false, caTrusted: false, certutil: false, browsers: browsers(), onPath: false, packageManagers: { npm: "10.2.4", pnpm: "", yarn: "1.22.22", bun: "" } };
    case "nopassword":
      return { ...ready, proxy: "none", caExists: false, caTrusted: false, browsers: browsers(), dialog: false };
    case "degraded":
      return { ...ready, portless: undefined, proxy: "none" };
    case "readonly":
      return { ...ready, dekit: undefined, portless: undefined, proxy: "none" };
    default:
      return ready;
  }
}

const ORIGIN_LABEL: Record<ToolOrigin["kind"], string> = {
  script: "dekit's install script",
  homebrew: "Homebrew",
  npm: "npm (global)",
  portplane: "Portplane",
  mise: "mise",
  fnm: "fnm",
  volta: "Volta",
  nvm: "nvm",
  asdf: "asdf",
  pip: "pip",
  cargo: "Cargo",
  system: "your system's packages",
  other: "an unknown method",
};

function origin(kind: ToolOrigin["kind"], path: string, update?: string[]): ToolOrigin {
  return { kind, label: ORIGIN_LABEL[kind], path, update };
}

function profileStatus(m: MachineModel, p: Profile): BrowserProfile {
  const base = { id: p.id, name: p.name, dir: p.dir, default: p.default, canAdd: m.certutil && m.caExists };
  if (!m.caExists) return { ...base, status: "no-ca", detail: "The certificate is created when the proxy starts." };
  if (p.inDb && m.certutil) return { ...base, status: "trusted", detail: "The CA is in this browser's own certificates." };
  if (!p.own && m.caTrusted) return { ...base, status: "system", detail: "Uses your system's certificates, which trust the CA." };
  if (!m.certutil) return { ...base, status: "unknown", detail: "Portplane needs certutil to check and add the CA here." };
  return { ...base, status: "missing", detail: "This browser keeps its own certificates and doesn't have the CA." };
}

export function browserReport(m: MachineModel): BrowserReport {
  return {
    ca: `${HOME}/.portless/ca.pem`,
    caExists: m.caExists,
    systemTrusted: m.caTrusted,
    p11kit: false,
    certutil: m.certutil ? "/usr/bin/certutil" : undefined,
    certutilHint: m.certutil ? undefined : "sudo apt install libnss3-tools",
    browsers: m.browsers.map((b) => ({ id: b.id, variant: b.variant, name: b.name, store: "nss", profiles: b.profiles.map((p) => profileStatus(m, p)) })),
  };
}

function needsBrowserAction(r: BrowserReport): string[] {
  return r.browsers.filter((b) => b.profiles.some((p) => p.status === "missing" || p.status === "outdated" || p.status === "unknown")).map((b) => b.name);
}

function plans(m: MachineModel): Record<ToolId, InstallPlan> {
  const nodeOK = !!m.privateNode || major(m.node) >= 24;
  const npmOwn = nodeOK && !m.privateNode;
  return {
    dekit: {
      tool: "dekit",
      method: "script",
      source: "dekit's official installer (https://dekit.run/install.sh), which downloads the latest release from github.com/pvolok/dekit",
      checksum: "The installer checks the release against its published SHA256SUMS before installing it.",
      destination: "~/.local/bin/dekit",
      password: false,
      steps: ["Download dekit's installer", "Install dekit (its installer checks the SHA-256)", "Check that dekit runs"],
      manual: ["curl -fsSL https://dekit.run/install.sh | sh"],
      docs: "https://dekit.run",
    },
    node: {
      tool: "node",
      method: "private",
      version: "24",
      source: "nodejs.org/dist (the latest Node.js 24 for this computer)",
      checksum: "Checked against the release's SHASUMS256.txt before it is unpacked.",
      destination: "~/.local/share/portplane/node/v24.x.y",
      password: false,
      steps: ["Find the latest Node.js 24", "Download", "Verify the SHA-256 checksum", "Unpack", "Check that node runs"],
      manual: m.managers.includes("mise") ? ["mise use -g node@24"] : [],
      docs: "https://nodejs.org/en/download",
      alternatives: m.managers.map((mg) => ({ method: mg, label: `Use ${mg}`, commands: mg === "fnm" ? ["fnm install 24", "fnm default 24"] : [`${mg} ${mg === "mise" ? "use -g" : "install"} node@24`] })),
    },
    portless: {
      tool: "portless",
      method: npmOwn ? "npm" : "private",
      source: "The npm registry (registry.npmjs.org, or the registry your npm is set to)",
      checksum: "npm checks every package against the integrity hash the registry publishes.",
      destination: npmOwn ? "~/.local/share/mise/installs/node/24.11.0/bin" : "~/.local/share/portplane/portless, with a launcher at ~/.local/bin/portless",
      password: false,
      steps: npmOwn
        ? ["Find Node.js 24", "Install portless with npm (npm checks each package)", "Check that portless runs"]
        : ["Find Node.js 24", "Install portless with npm (npm checks each package)", "Write the portless launcher", "Check that portless runs"],
      manual: ["npm install -g portless"],
      docs: "https://github.com/vercel-labs/portless",
    },
  };
}

function major(v: string | undefined): number {
  const m = /(\d+)\./.exec(v ?? "");
  return m ? Number(m[1]) : 0;
}

const SERVICE_TERMINAL = `sudo env HOME=${HOME} ${BIN}/portless service install --port 443 --https`;

/** The check as the server would report it for this machine. */
export function evaluateMachine(m: MachineModel): SetupCheck {
  const reqs: Requirement[] = [];
  const p = plans(m);
  const nodeVersion = m.privateNode ?? m.node;
  const nodeOK = major(nodeVersion) >= 24;

  reqs.push({
    id: "dekit",
    name: "dekit",
    why: "Runs and supervises your dev servers; Portplane writes its config and starts and stops tasks through it.",
    ok: !!m.dekit,
    status: m.dekit ? "ok" : "missing",
    version: m.dekit?.version,
    detail: m.dekit ? `Installed with ${ORIGIN_LABEL[m.dekit.origin]}` : undefined,
    problem: m.dekit ? undefined : "dekit was not found.",
    commands: m.dekit ? undefined : p.dekit.manual,
    docs: "https://dekit.run",
    privilege: false,
    fix: m.dekit ? undefined : "install-dekit",
    origin: m.dekit ? origin(m.dekit.origin, `${BIN}/dekit`, ["dekit", "update"]) : undefined,
    install: p.dekit,
  });
  reqs.push({
    id: "node",
    name: "Node.js 24 or later",
    why: "portless runs on Node.js 24+.",
    ok: nodeOK,
    status: nodeOK ? "ok" : m.node ? "outdated" : "missing",
    version: nodeVersion,
    detail: m.privateNode ? `Portplane's own copy, used only by portless${m.node ? ` (your Node.js ${m.node} stays as it is)` : ""}` : nodeOK ? "Installed with mise" : undefined,
    problem: nodeOK ? undefined : m.node ? `Node.js ${m.node} is too old for portless.` : "Node.js was not found.",
    commands: nodeOK ? undefined : m.managers.includes("mise") ? ["mise use -g node@24"] : ["mise use -g node@24"],
    docs: "https://nodejs.org",
    privilege: false,
    fix: nodeOK ? undefined : "install-node",
    install: p.node,
  });
  reqs.push({
    id: "portless",
    name: "portless",
    why: "Gives every dev server a stable https://<name>.localhost URL, whatever port it lands on.",
    ok: !!m.portless,
    status: m.portless ? "ok" : "missing",
    version: m.portless?.version,
    detail: m.portless ? `Installed with ${ORIGIN_LABEL[m.portless.origin]}` : undefined,
    problem: m.portless ? undefined : "portless was not found.",
    commands: m.portless ? undefined : ["npm install -g portless"],
    docs: "https://github.com/vercel-labs/portless",
    privilege: false,
    fix: m.portless ? undefined : "install-portless",
    install: p.portless,
  });
  reqs.push({
    id: "git",
    name: "git",
    why: "Lets setup find your projects and their worktrees.",
    ok: !!m.git,
    status: m.git ? "ok" : "warning",
    version: m.git,
    optional: true,
    privilege: false,
  });
  const pms = Object.entries(m.packageManagers);
  const have = pms.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  const missingPms = pms.filter(([, v]) => !v).map(([k]) => k);
  reqs.push({
    id: "packages",
    name: "Package managers",
    why: "Your apps install and start with npm, pnpm, Yarn or Bun; setup tells you if one it needs is missing.",
    ok: true,
    status: "info",
    detail: have.length === 0 ? `None found yet: ${missingPms.join(", ")}.` : `${have.join(" · ")}${missingPms.length ? ` (not found: ${missingPms.join(", ")})` : ""}`,
    managers: m.packageManagers,
    privilege: false,
  });
  const portBusy = m.port443 && m.proxy !== "service";
  reqs.push({
    id: "port",
    name: "Port 443",
    why: "HTTPS addresses without a port number need the proxy on port 443.",
    ok: !portBusy,
    status: portBusy ? "warning" : "ok",
    detail: portBusy ? undefined : m.proxy === "service" ? "The portless proxy answers on it." : "Free for the proxy.",
    problem: portBusy ? `${m.port443!.process} (PID ${m.port443!.pid}) is using port 443, so the proxy can't. Stop it, or use port 1355 instead.` : undefined,
    optional: portBusy || undefined,
    fix: portBusy ? "use-1355" : undefined,
    port: { port: 443, free: m.proxy === "none" && !m.port443, portless: m.proxy === "service", pid: portBusy ? m.port443!.pid : undefined, process: portBusy ? m.port443!.process : undefined, known: true },
    privilege: false,
  });
  const running = m.proxy !== "none";
  reqs.push({
    id: "proxy",
    name: "portless proxy",
    why: "Serves the .localhost URLs over HTTPS with a trusted local certificate, and starts with your computer.",
    ok: running,
    status: running ? "ok" : "missing",
    detail:
      m.proxy === "service"
        ? "Installed as a service: it starts with your computer."
        : m.proxy === "unprivileged"
          ? "Running on port 1355: addresses carry :1355."
          : undefined,
    problem: running ? undefined : m.portless ? "The proxy isn't set up yet." : "Needs portless first.",
    commands: running ? undefined : [SERVICE_TERMINAL],
    privilege: true,
    fix: "proxy",
    service: {
      installed: m.proxy === "service",
      responding: running,
      running,
      port: m.proxy === "unprivileged" ? 1355 : 443,
      https: true,
      tlds: ["localhost"],
      lan: false,
      nodeMissing: false,
      installCommand: SERVICE_TERMINAL,
    },
  });
  const report = browserReport(m);
  const untrusted = needsBrowserAction(report);
  const caProblem = m.caExists && !m.caTrusted ? "Your system doesn't trust the certificate yet." : undefined;
  const caNote = m.caExists && untrusted.length ? `Not trusted yet by ${untrusted.join(", ")}.` : undefined;
  reqs.push({
    id: "ca",
    name: "Local certificate",
    why: "Browsers trust https://….localhost addresses once they trust portless's local certificate authority.",
    ok: !m.caExists || (!caProblem && !caNote),
    status: !m.caExists ? "info" : caProblem ? "missing" : caNote ? "warning" : "ok",
    detail: !m.caExists ? "Created when the proxy is set up." : !caProblem && !caNote ? "Trusted by your system and your browsers." : undefined,
    problem: [caProblem, caNote].filter(Boolean).join(" ") || undefined,
    commands: caProblem ? ["sudo portless trust"] : undefined,
    privilege: !!caProblem,
    fix: caProblem ? "trust-system" : caNote ? "trust-browsers" : undefined,
    browsers: m.caExists ? report : undefined,
  });
  reqs.push({ id: "hosts", name: "/etc/hosts", why: "Names under a top-level domain other than .localhost resolve through /etc/hosts.", ok: true, status: "skipped", detail: ".localhost names need no /etc/hosts entries.", privilege: true });
  reqs.push({ id: "lan", name: "LAN tools", why: "LAN mode publishes your apps as .local names for phones and other computers.", ok: true, status: "skipped", detail: "LAN mode is off.", privilege: false });
  const path = pathStatus(m);
  reqs.push({
    id: "path",
    name: "~/.local/bin on PATH",
    why: "Lets your terminal find dekit and portless. Portplane itself doesn't need it.",
    ok: path.onPath,
    status: path.onPath ? "ok" : "warning",
    detail: path.onPath ? "Your terminal finds the tools installed there." : undefined,
    problem: path.onPath ? undefined : "New terminals won't find the tools Portplane installs there.",
    commands: path.onPath ? undefined : [path.line!],
    optional: true,
    fix: path.onPath ? undefined : "path-profile",
    path,
    privilege: false,
  });
  reqs.push({
    id: "tray",
    name: "Tray icon",
    why: "Shows Portplane in the top bar or tray, so you can reopen it and see your apps at a glance.",
    ok: true,
    status: "info",
    problem: "GNOME shows tray icons only with the AppIndicator extension.",
    commands: ["https://extensions.gnome.org/extension/615/appindicator-support/"],
    docs: "https://extensions.gnome.org/extension/615/appindicator-support/",
    optional: true,
    privilege: false,
  });
  reqs.push({ id: "portplane", name: "portplane on PATH", why: "A few generated tasks (Sanity, Remotion) call `portplane port-exec` to pass the port.", ok: true, status: "ok", optional: true, privilege: false });

  return { requirements: reqs, ready: !!m.dekit && !!m.portless && nodeOK, admin: m.dialog ? "pkexec" : "", os: "linux" };
}

function pathStatus(m: MachineModel): PathStatus {
  return { dir: BIN, onPath: m.onPath, shell: "bash", file: `${HOME}/.bashrc`, line: 'export PATH="$HOME/.local/bin:$PATH"', present: m.onPath };
}

export interface MockTools extends ToolsApi {
  /** The machine model, for tests. */
  machine(): MachineModel;
}

export function createMockTools(ctx: MockContext): MockTools {
  const m = machineFor(ctx.scenario);
  const effects = new Map<string, () => void>();

  // A job's effect lands when it succeeds, like the real install.
  ctx.jobs.onChange((job: Job) => {
    const fx = effects.get(job.id);
    if (!fx || job.state === "running") return;
    effects.delete(job.id);
    if (job.state === "succeeded") fx();
  });
  const start = (spec: MockJobSpec, effect: () => void) => {
    const job = ctx.jobs.start(spec);
    effects.set(job.id, effect);
    return job;
  };

  const syncSnapshot = () =>
    ctx.update((ms) => {
      ms.tools = {
        dekit: m.dekit?.version,
        portless: m.portless?.version,
        proxyRunning: m.proxy !== "none",
        proxyHttps: m.proxy !== "none",
        proxyPort: m.proxy === "unprivileged" ? 1355 : m.proxy === "service" ? 443 : undefined,
      };
    });

  const installSpec = (tool: ToolId, method: string | undefined): { spec: MockJobSpec; effect: () => void } => {
    const p = plans(m)[tool];
    if (tool === "dekit") {
      return {
        spec: {
          kind: "install",
          title: "Install dekit",
          steps: [
            { name: p.steps[0], ms: 700, output: ["Downloading https://dekit.run/install.sh", "Saved 3412 bytes, SHA-256 5b1f0c…a9e2"] },
            {
              name: p.steps[1],
              ms: 1800,
              output: [
                "Downloading https://github.com/pvolok/dekit/releases/latest/download/dekit-x86_64-unknown-linux-musl.tar.gz",
                "Downloading https://github.com/pvolok/dekit/releases/latest/download/SHA256SUMS",
                "dekit 0.10.3 installed to /home/dev/.local/bin/dekit",
              ],
            },
            { name: p.steps[2], ms: 500, output: ["$ dekit --version", "dekit 0.10.3", "Install receipt for `dekit update`: ~/.local/share/dekit/install -> /home/dev/.local/bin/dekit"] },
          ],
          result: { path: `${BIN}/dekit`, version: "0.10.3" },
        },
        effect: () => {
          m.dekit = { version: "0.10.3", origin: "script" };
          syncSnapshot();
        },
      };
    }
    if (tool === "node") {
      if (method && method !== "private") {
        return {
          spec: {
            kind: "install",
            title: "Install Node.js 24",
            steps: [
              { name: `Install with ${method}`, ms: 2200, output: [`$ ${method} use -g node@24`, "mise node@24.11.0 ✓ installed", "mise ~/.config/mise/config.toml tools: node@24.11.0"] },
              { name: "Check that node runs", ms: 400, output: ["$ node --version", "v24.11.0"] },
            ],
          },
          effect: () => {
            m.node = "v24.11.0";
            m.packageManagers.npm ||= "11.6.2";
          },
        };
      }
      return {
        spec: {
          kind: "install",
          title: "Install Node.js 24",
          steps: [
            { name: p.steps[0], ms: 500, output: ["Node.js v24.11.0 for this computer: node-v24.11.0-linux-x64.tar.gz", "Published SHA-256: 3d4f8a…b20c (https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)"] },
            { name: p.steps[1], ms: 1800, output: ["Downloading https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.gz", "  5.6 MB of 28.4 MB", "  14.2 MB of 28.4 MB", "  22.7 MB of 28.4 MB", "  28.4 MB of 28.4 MB"] },
            { name: p.steps[2], ms: 300, output: ["SHA-256 3d4f8a…b20c matches SHASUMS256.txt"] },
            { name: p.steps[3], ms: 700, output: ["Unpacked into ~/.local/share/portplane/node/v24.11.0"] },
            { name: p.steps[4], ms: 300, output: ["$ node --version", "v24.11.0"] },
          ],
          result: { path: `${DATA}/node/v24.11.0/bin/node`, version: "v24.11.0", private: true },
        },
        effect: () => {
          m.privateNode = "v24.11.0";
          m.packageManagers.npm ||= "11.6.2"; // npm comes with Node
        },
      };
    }
    // portless
    const nodeOK = !!m.privateNode || major(m.node) >= 24;
    const steps = p.steps;
    const failAt = nodeOK ? undefined : 0;
    return {
      spec: {
        kind: "install",
        title: "Install portless",
        steps: steps.map((name, i) => ({
          name,
          ms: [400, 2400, 400, 400][i] ?? 400,
          output: [
            [nodeOK ? `Node.js ${m.privateNode ?? m.node} at ${m.privateNode ? "~/.local/share/portplane/node/v24.11.0/bin/node" : "~/.local/share/mise/installs/node/24.11.0/bin/node"}` : ""],
            [p.method === "private" ? "$ npm install -g --prefix ~/.local/share/portplane/portless portless" : "$ npm install -g portless", "", "added 12 packages in 3s"],
            steps.length === 4 && i === 2 ? ["Wrote ~/.local/bin/portless, which runs portless with ~/.local/share/portplane/node/v24.11.0/bin/node"] : ["$ portless --version", "0.16.0"],
            ["$ portless --version", "0.16.0"],
          ][i].filter((l) => l !== ""),
        })),
        failAt,
        error: nodeOK ? undefined : `portless needs Node.js 24 or later${m.node ? `, and this computer has ${m.node}` : ""}: install Node.js 24 first`,
        result: { path: p.method === "private" ? `${BIN}/portless` : "/home/dev/.local/share/mise/installs/node/24.11.0/bin/portless", version: "0.16.0", method: p.method },
      },
      effect: () => {
        m.portless = { version: "0.16.0", origin: p.method === "private" ? "portplane" : "npm" };
        syncSnapshot();
      },
    };
  };

  const proxyEffect = (mode: "service" | "unprivileged") => () => {
    m.proxy = mode;
    m.caExists = true;
    if (mode === "service") m.caTrusted = true;
    syncSnapshot();
  };

  const verifySteps = (url: string, trusted: boolean) => [
    { name: "Check that the proxy answers", ms: 600, output: [`The proxy answers on port ${url.includes(":1355") ? 1355 : 443}.`] },
    {
      name: "Check the certificate",
      ms: 400,
      output: [trusted ? "Your system trusts the local certificate (4A:1F:…:C2)." : "Your system doesn't trust the local certificate yet: browsers will warn until it does."],
    },
    { name: "Open https://portplane.localhost", ms: 500, output: [trusted ? `${url} loads.` : `${url} does not load yet: x509: certificate signed by unknown authority`] },
  ];

  const preview = (argv: string[], needsAdmin: boolean): CommandPreview => {
    const env = { HOME, PATH: `${BIN}:/usr/local/bin:/usr/bin:/bin`, SUDO_USER: "dev", SUDO_UID: "1000", SUDO_GID: "1000" };
    return {
      argv,
      env: needsAdmin ? env : { HOME },
      terminal: needsAdmin ? `sudo env HOME=${HOME} ${argv.join(" ")}` : argv.join(" "),
      admin: m.dialog ? "pkexec" : "",
      needsAdmin,
    };
  };

  const noDialog = (terminal: string) =>
    `this computer can't show a password dialog here. Run this in a terminal, then check again: ${terminal}`;

  const optionArgs = (o: ProxyOptions) => {
    const args = ["--port", String(o.port)];
    if (o.https && o.certPath) args.push("--cert", o.certPath, "--key", o.keyPath ?? "");
    else args.push(o.https ? "--https" : "--no-tls");
    const tlds = (o.tlds ?? []).filter(Boolean);
    if (tlds.length > 1 || (tlds[0] && tlds[0] !== "localhost")) for (const t of tlds) args.push("--tld", t);
    if (o.wildcard) args.push("--wildcard");
    if (o.unprivileged) args.push("--unprivileged");
    return args;
  };
  const validate = (o: ProxyOptions) => {
    if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new ApiError(`port ${o.port} is not between 1 and 65535`, 400);
    for (const t of o.tlds ?? []) if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(t.replace(/^\./, ""))) throw new ApiError(`"${t}" is not a valid top-level domain`, 400);
    if (!!o.certPath !== !!o.keyPath) throw new ApiError("a custom certificate needs both the certificate and its key", 400);
    for (const p of [o.certPath, o.keyPath]) if (p && !p.startsWith("/")) throw new ApiError(`give the certificate and its key as full paths, not "${p}"`, 400);
  };

  return {
    machine: () => m,

    async checkSome(ids: RequirementId[]) {
      // Each check takes its own time, like the real ones.
      const slow: Partial<Record<RequirementId, number>> = { node: 500, portless: 650, port: 350, proxy: 900, ca: 1200, path: 450, packages: 750 };
      const ms = Math.max(200, ...ids.map((id) => slow[id] ?? 250));
      const c = evaluateMachine(m);
      return ctx.delay({ ...c, requirements: c.requirements.filter((r) => ids.includes(r.id)) }, ms);
    },

    async installTool(tool, method) {
      await ctx.delay(undefined, 150);
      if (!["dekit", "node", "portless"].includes(tool)) throw new ApiError(`unknown tool "${tool}": dekit, node or portless`, 400);
      const { spec, effect } = installSpec(tool, method);
      return start(spec, effect);
    },

    async proxyServicePreview(options) {
      await ctx.delay(undefined, 120);
      validate(options);
      if (!m.portless) throw new ApiError("portless is not installed", 409);
      return preview([`${BIN}/portless`, "service", "install", ...optionArgs(options)], true);
    },

    async installProxyService(options) {
      await ctx.delay(undefined, 150);
      validate(options);
      if (!m.portless) throw new ApiError("portless is not installed", 409);
      const terminal = preview([`${BIN}/portless`, "service", "install", ...optionArgs(options)], true).terminal;
      if (!m.dialog) {
        return start(
          {
            kind: "proxy-service",
            title: "Install the proxy service",
            privileged: true,
            steps: [
              { name: "Ask for your password", ms: 600, output: [`$ ${terminal}`] },
              { name: "Install the proxy service", ms: 100 },
              { name: "Check that the proxy answers", ms: 100 },
              { name: "Check the certificate", ms: 100 },
              { name: "Open https://portplane.localhost", ms: 100 },
            ],
            failAt: 0,
            error: noDialog(terminal),
            result: { terminal } satisfies Partial<ProxyResult>,
          },
          () => {},
        );
      }
      return start(
        {
          kind: "proxy-service",
          title: "Install the proxy service",
          privileged: true,
          steps: [
            { name: "Ask for your password", ms: 1800, output: [`$ ${terminal}`] },
            {
              name: "Install the proxy service",
              ms: 1600,
              output: ["Generated local CA certificate.", "Trusting portless CA for service startup...", "CA added to the system trust store.", "Portless service installed.", "State directory: /home/dev/.portless", "Proxy port: 443"],
            },
            ...verifySteps("https://portplane.localhost", true),
          ],
          result: { url: "https://portplane.localhost", answers: true, caTrusted: true, loads: true, terminal, unprivileged: false } satisfies ProxyResult,
        },
        proxyEffect("service"),
      );
    },

    async startProxy(options = NO_PASSWORD_PROXY) {
      await ctx.delay(undefined, 150);
      validate(options);
      if (!m.portless) throw new ApiError("portless is not installed", 409);
      if (options.port < 1024) throw new ApiError(`port ${options.port} needs your password on this computer: install the proxy service instead, or use port 1355`, 400);
      const url = `https://portplane.localhost:${options.port}`;
      return start(
        {
          kind: "proxy-start",
          title: `Start the proxy on port ${options.port}`,
          steps: [
            { name: `Start the proxy on port ${options.port}`, ms: 1400, output: [`$ portless proxy start ${optionArgs(options).join(" ")}`, "Generated local CA certificate.", "The portless CA is not in the system trust store.", `Proxy started on port ${options.port}`] },
            ...verifySteps(url, false),
          ],
          result: { url, answers: true, caTrusted: false, loads: false, terminal: "", unprivileged: true } satisfies ProxyResult,
        },
        proxyEffect("unprivileged"),
      );
    },

    browserTrust: () => ctx.delay(browserReport(m), 600),

    async trustBrowser(browser, profile) {
      await ctx.delay(undefined, 700);
      const b = m.browsers.find((x) => x.id === browser || `${x.id}-${x.variant}` === browser);
      const p = b?.profiles.find((x) => x.id === profile);
      if (!p) throw new ApiError("no such browser profile", 404);
      if (!m.caExists) throw new ApiError("there is no portless CA yet: set up the proxy first", 422);
      if (!m.certutil) throw new ApiError("certutil is not installed: sudo apt install libnss3-tools", 422);
      p.inDb = true;
      return profileStatus(m, p);
    },

    async systemTrustPreview() {
      await ctx.delay(undefined, 120);
      if (!m.portless) throw new ApiError("portless is not installed", 409);
      return preview([`${BIN}/portless`, "trust"], true);
    },

    async trustSystem() {
      await ctx.delay(undefined, 150);
      if (!m.portless) throw new ApiError("portless is not installed", 409);
      const terminal = preview([`${BIN}/portless`, "trust"], true).terminal;
      const spec: MockJobSpec = {
        kind: "trust",
        title: "Trust the local certificate",
        privileged: true,
        steps: [
          { name: "Ask for your password", ms: m.dialog ? 1500 : 500, output: [`$ ${terminal}`] },
          { name: "Trust the certificate", ms: 900, output: ["CA added to system trust store. Browsers will trust portless certs."] },
          { name: "Check the certificate", ms: 300 },
        ],
        failAt: m.dialog ? undefined : 0,
        error: m.dialog ? undefined : noDialog(terminal),
        result: m.dialog ? undefined : { terminal },
      };
      return start(spec, () => {
        m.caTrusted = true;
      });
    },

    pathProfile: () => ctx.delay(pathStatus(m), 200),

    async addPathToProfile() {
      await ctx.delay(undefined, 300);
      m.onPath = true;
      return pathStatus(m);
    },

    folderSuggestions: () =>
      ctx.delay<FolderSuggestion[]>(
        ctx.scenario === "fresh"
          ? [{ path: `${HOME}/code`, repos: 3 }]
          : [
              { path: `${HOME}/code`, repos: 3 },
              { path: `${HOME}/projects`, repos: 1 },
            ],
        400,
      ),
  };
}

