import { seg, type Http } from "./http";
import type { Job } from "./jobs";

// The portless part of the API (plan §5, M5.2): proxy, routes, aliases,
// names, portless.json, certificates, hosts, doctor and maintenance.
// Mirrors internal/server/portless*.go; the mock lives in mockPortless.ts.

export interface ProxyOptions {
  port: number;
  https: boolean;
  /** The first one is the main one; empty means localhost. */
  tlds?: string[];
  wildcard: boolean;
  lan: boolean;
  lanIp?: string;
  unprivileged: boolean;
  certPath?: string;
  keyPath?: string;
}

export interface ProxyState {
  /** A request got portless's own X-Portless header back. */
  responding: boolean;
  /** The process in proxy.pid is alive. */
  running: boolean;
  port: number;
  https: boolean;
  tlds: string[];
  lan: boolean;
  lanIp?: string;
  unprivileged: boolean;
  customCert: boolean;
  pid?: number;
  /** It runs as the administrator: stopping it asks for the password. */
  asRoot: boolean;
  /** The proxy has run here before (proxy.port exists). */
  configured: boolean;
}

export interface ServiceStatus {
  installed: boolean;
  managerState: string;
  responding: boolean;
  port: number;
  https: boolean;
  tlds: string[];
  lan: boolean;
  lanIp?: string;
  wildcard: boolean;
  unprivileged: boolean;
  stateDir?: string;
  entry?: string;
  nodePath?: string;
  nodeMissing: boolean;
  parsed: boolean;
  raw: string;
}

export interface ServiceProgram {
  node: string;
  script: string;
  args: string[];
  nodeMissing: boolean;
  scriptMissing: boolean;
}

export type InstallOrigin = "npm" | "homebrew" | "portplane" | "pnpm" | "bun" | "volta" | "unknown";

export interface ToolCommand {
  argv: string[];
  env?: Record<string, string>;
  admin: boolean;
}

export interface PortlessInstall {
  origin: InstallOrigin;
  bin: string;
  script?: string;
  prefix?: string;
  update?: ToolCommand;
  uninstall?: ToolCommand;
}

export interface PortlessStatus {
  installed: boolean;
  version?: string;
  path?: string;
  stateDir: string;
  os: string;
  proxy: ProxyState;
  service?: ServiceStatus;
  serviceError?: string;
  program?: ServiceProgram;
  /** The options the proxy runs with now; the form starts from them. */
  options: ProxyOptions;
  adminToStart: boolean;
  adminToStop: boolean;
  /** How the password is asked ("pkexec", "osascript", "uac"), or "" when it can't be. */
  method: string;
  install: PortlessInstall;
  hostsNeeded: boolean;
}

export type FindingStatus = "ok" | "warn" | "fail" | "info";
export type FixKind = "proxy-start" | "proxy-restart" | "trust" | "prune" | "hosts-sync" | "service-install";

export interface Finding {
  status: FindingStatus;
  message: string;
  hint?: string;
  check: string;
  fix?: FixKind;
  subject?: string;
}

export interface DoctorReport {
  version?: string;
  node?: string;
  platform?: string;
  stateDir?: string;
  proxyTarget?: string;
  mode?: string;
  findings: Finding[];
  failures: number;
  warnings: number;
  parsed: boolean;
  unparsed?: string[];
  raw: string;
  error?: string;
}

export type RouteKind = "app" | "alias" | "compose" | "remote";

export interface RouteOwner {
  kind: "app" | "process" | "portplane" | "remote" | "compose";
  label: string;
  machine?: string;
  appId?: string;
  pid?: number;
  process?: string;
}

export interface SharedUrl {
  kind: "tailscale" | "funnel" | "ngrok" | "cloudflare";
  url: string;
}

export interface RouteView {
  hostname: string;
  port: number;
  pid: number;
  registeredAt?: number;
  childPgid?: number;
  alive: boolean;
  kind: RouteKind;
  compose?: string;
  shared: SharedUrl[];
  url: string;
  owner?: RouteOwner;
}

export interface Listener {
  port: number;
  pid?: number;
  process?: string;
}

export interface StaleRoute {
  hostname: string;
  port: number;
  pid: number;
  processes: Listener[];
}

export interface PruneLine {
  hostname: string;
  port?: number;
  pid?: number;
  action: "removed" | "killed" | "exited" | "killed-group" | "tunnel";
  signal?: string;
}

export interface PruneResult {
  routes: number;
  killed: number;
  lines: PruneLine[];
  parsed: boolean;
}

export interface AliasRequest {
  /** The hostname being replaced, when editing. */
  from?: string;
  name: string;
  port: number;
  /** Take the name over when another route holds it (portless alias --force). */
  force: boolean;
}

export interface CA {
  exists: boolean;
  path: string;
  fingerprint?: string;
  subject?: string;
  notAfter?: string;
  trusted: boolean;
  systemCopy?: string;
  systemCopyNotRoot?: boolean;
}

export interface HostCert {
  file: string;
  names: string[];
  notAfter?: string;
  signedByCa: boolean;
}

export interface BrowserTrust {
  browser: string;
  profile?: string;
  trusted: boolean;
  detail?: string;
}

export interface Certificates {
  ca: CA;
  hostCerts: HostCert[];
  /** Absent until the browser check (onboarding, M5.1) is wired in. */
  browsers?: BrowserTrust[];
  os: string;
  method: string;
  trustNeedsAdmin: boolean;
}

export interface HostsEntry {
  address: string;
  names: string[];
}

export interface HostsView {
  path: string;
  readable: boolean;
  block: boolean;
  entries: HostsEntry[];
  missing: string[];
  extra: string[];
  inSync: boolean;
  /** A domain other than .localhost needs the hosts file. */
  needed: boolean;
  tlds: string[];
}

export type PortlessAction =
  | "proxy-start"
  | "proxy-stop"
  | "proxy-restart"
  | "service-install"
  | "service-uninstall"
  | "trust"
  | "ca-regenerate"
  | "ca-fix-ownership"
  | "hosts-sync"
  | "hosts-clean"
  | "prune"
  | "prune-force"
  | "update"
  | "uninstall";

export interface PlanStep {
  label: string;
  /** Empty: Portplane does it itself (moving files aside, checking a version). */
  argv?: string[];
  env?: Record<string, string>;
  admin: boolean;
  /** The same command for a terminal, when no password dialog can open. */
  terminal?: string;
  /** When a conditional step runs. */
  when?: string;
}

export interface Plan {
  action: PortlessAction;
  title: string;
  summary: string;
  admin: boolean;
  steps: PlanStep[];
  notes?: string[];
  method: string;
}

export type NameSource = "fragment" | "task" | "config" | "alias-task" | "alias" | "compose" | "none";

export interface NameInfo {
  source: NameSource;
  name: string;
  inferred: boolean;
  hostname: string;
  editable: boolean;
  reason: string;
  file?: string;
  task?: string;
  target?: string;
  tld: string;
  runMode: boolean;
  prefix?: string;
  port?: number;
  compose?: string;
  taken: string[];
  notes: string[];
  running: boolean;
  dir?: string;
}

export interface FileEdit {
  path: string;
  before: string;
  after: string;
  created: boolean;
  changed: boolean;
}

export interface NamePreview {
  name: string;
  hostname?: string;
  url?: string;
  problem?: string;
  files: FileEdit[];
  steps: string[];
  warnings: string[];
  digest?: string;
}

export interface ConfigApp {
  id: string;
  label: string;
  project: string;
  runMode: boolean;
}

export interface ConfigPlace {
  dir: string;
  wins: "" | "portless.json" | "package.json";
  apps: ConfigApp[];
}

export interface AppConfig {
  name?: string;
  script?: string;
  appPort?: number;
  proxy?: boolean;
}

export interface ProjectConfig extends AppConfig {
  turbo?: boolean;
  apps?: Record<string, AppConfig>;
}

export interface ConfigSource {
  path: string;
  exists: boolean;
  hasConfig: boolean;
  text?: string;
  config?: ProjectConfig;
  problems: string[];
  warnings: string[];
  digest?: string;
}

export type ConfigTarget = "portless.json" | "package.json";

export interface ProjectConfigs {
  dir: string;
  portless: ConfigSource;
  package: ConfigSource;
  wins: "" | ConfigTarget;
  packageName?: string;
}

export interface ConfigPreview {
  edit?: FileEdit;
  problems: string[];
  warnings: string[];
}

export interface PortlessApi {
  portlessStatus(): Promise<PortlessStatus>;
  /** Runs portless doctor (a second or two). */
  portlessDoctor(): Promise<DoctorReport>;
  portlessRoutes(): Promise<RouteView[]>;
  /** Stale routes and the processes prune would stop. */
  portlessPrunePreview(): Promise<StaleRoute[]>;
  /** Adds an alias; resolves with every route after the change. */
  portlessAddAlias(req: AliasRequest): Promise<RouteView[]>;
  /** Replaces the alias at req.from with the new name and port. */
  portlessReplaceAlias(req: AliasRequest): Promise<RouteView[]>;
  portlessRemoveAlias(hostname: string): Promise<RouteView[]>;
  portlessCertificates(): Promise<Certificates>;
  /** Copies ca.pem to the Downloads folder and shows it. */
  portlessExportCA(): Promise<{ path: string; revealed: boolean }>;
  portlessHosts(): Promise<HostsView>;
  /** What an action will run, before it runs. */
  portlessPlan(action: PortlessAction, options?: ProxyOptions): Promise<Plan>;
  /** Runs an action as a job (the same plan, built again from the same choices). */
  portlessRun(action: PortlessAction, options?: ProxyOptions): Promise<Job>;
  portlessNameInfo(machine: string, app: string): Promise<NameInfo>;
  portlessNamePreview(machine: string, app: string, name: string): Promise<NamePreview>;
  /** Writes the previewed change; 409 when a file changed since the preview. */
  portlessRename(machine: string, app: string, name: string, digest: string): Promise<Job>;
  portlessConfigs(): Promise<ConfigPlace[]>;
  portlessConfig(dir: string): Promise<ProjectConfigs>;
  portlessConfigPreview(dir: string, target: ConfigTarget, text: string): Promise<ConfigPreview>;
  /** Saves; 409 when the file changed since it was read (digest). */
  portlessConfigSave(dir: string, target: ConfigTarget, text: string, digest: string): Promise<ProjectConfigs>;
}

export function createPortlessHttp(h: Http): PortlessApi {
  const { json } = h;
  const body = (options?: ProxyOptions) => (options ? { options } : {});
  return {
    portlessStatus: () => json<PortlessStatus>("GET", "/api/portless/status"),
    portlessDoctor: () => json<DoctorReport>("GET", "/api/portless/doctor"),
    portlessRoutes: () => json<RouteView[]>("GET", "/api/portless/routes"),
    portlessPrunePreview: () => json<StaleRoute[]>("GET", "/api/portless/prune"),
    portlessAddAlias: (req) => json<RouteView[]>("POST", "/api/portless/aliases", req),
    portlessReplaceAlias: (req) => json<RouteView[]>("PUT", "/api/portless/aliases", req),
    portlessRemoveAlias: (hostname) => json<RouteView[]>("DELETE", `/api/portless/aliases/${seg(hostname)}`),
    portlessCertificates: () => json<Certificates>("GET", "/api/portless/certificates"),
    portlessExportCA: () => json<{ path: string; revealed: boolean }>("POST", "/api/portless/certificates/export", {}),
    portlessHosts: () => json<HostsView>("GET", "/api/portless/hosts"),
    portlessPlan: (action, options) => json<Plan>("POST", `/api/portless/actions/${seg(action)}/plan`, body(options)),
    portlessRun: (action, options) => json<Job>("POST", `/api/portless/actions/${seg(action)}`, body(options)),
    portlessNameInfo: (machine, app) => json<NameInfo>("GET", `/api/portless/names?${new URLSearchParams({ machine, app })}`),
    portlessNamePreview: (machine, app, name) => json<NamePreview>("POST", "/api/portless/names/preview", { machine, app, name }),
    portlessRename: (machine, app, name, digest) => json<Job>("POST", "/api/portless/names/apply", { machine, app, name, digest }),
    portlessConfigs: () => json<ConfigPlace[]>("GET", "/api/portless/configs"),
    portlessConfig: (dir) => json<ProjectConfigs>("GET", `/api/portless/config?${new URLSearchParams({ dir })}`),
    portlessConfigPreview: (dir, target, text) => json<ConfigPreview>("POST", "/api/portless/config/preview", { dir, target, text }),
    portlessConfigSave: (dir, target, text, digest) => json<ProjectConfigs>("PUT", "/api/portless/config", { dir, target, text, digest }),
  };
}
