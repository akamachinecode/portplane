import type { Http } from "./http";
import type { Job } from "./jobs";
import type { CA, FileEdit, NameSource, ProxyOptions, RouteOwner, SharedUrl } from "./portless";

// Sharing apps, Docker Compose projects and LAN mode (M5.6): the part of
// the portless API in internal/server/portless_{share,compose,lan}.go. It
// is spread into PortlessApi (portless.ts) and mocked in mockSharing.ts.

export type ShareKind = SharedUrl["kind"];

/** One thing a feature needs, and how to fix it when it's missing. */
export interface Requirement {
  id: string;
  ok: boolean;
  label: string;
  problem?: string;
  fix?: string;
  /** A command to copy. */
  command?: string;
  /** An official page to open. */
  url?: string;
  /** A fix Portplane runs itself. */
  action?: "ngrok-authtoken" | "tailscale-operator";
}

export interface ShareProvider {
  kind: ShareKind;
  label: string;
  public: boolean;
  ready: boolean;
  /** What a shared address looks like. */
  where: string;
  requirements: Requirement[];
  notes: string[];
}

export interface ShareView {
  hostname: string;
  kind: ShareKind;
  url: string;
  public: boolean;
  alive: boolean;
  owner?: RouteOwner;
  /** Portplane can stop it; otherwise reason says how. */
  editable: boolean;
  reason?: string;
}

export interface SharingOverview {
  os: string;
  providers: ShareProvider[];
  shares: ShareView[];
}

export interface ShareInfo {
  hostname: string;
  source: NameSource;
  editable: boolean;
  reason?: string;
  file?: string;
  task?: string;
  running: boolean;
  /** Shares the app's command turns on. */
  on: ShareKind[];
  /** Shares the task's environment turns on (PORTLESS_NGROK=1…). */
  env: ShareKind[];
  /** The addresses portless reports for the app now. */
  shared: SharedUrl[];
  providers: ShareProvider[];
}

export interface SharePreview {
  kind: ShareKind;
  on: boolean;
  public: boolean;
  problem?: string;
  missing: Requirement[];
  replaces?: ShareKind;
  files: FileEdit[];
  steps: string[];
  warnings: string[];
  digest?: string;
}

export interface ComposePort {
  target: number;
  hostPort?: number;
  routed: boolean;
  reason?: string;
}

export interface ComposeService {
  name: string;
  label: string;
  nameLabel?: string;
  enabled: boolean;
  image?: string;
  ports: ComposePort[];
}

export interface ComposeRoute {
  hostname: string;
  url: string;
  port: number;
  service?: string;
  listening: boolean;
}

export type ComposeState = "running" | "stopped" | "down";

export interface ComposeProject {
  name: string;
  label: string;
  started: boolean;
  ports: Record<string, number>;
  services: ComposeService[];
  state: ComposeState;
  file?: string;
  fileFrom?: "remembered" | "task" | "containers" | "guess";
  routes: ComposeRoute[];
}

export interface ComposeOverview {
  docker: boolean;
  requirements: Requirement[];
  projects: ComposeProject[];
  tld: string;
}

export type ComposeOp = "up" | "down";

export interface ComposeRequest {
  op: ComposeOp;
  project?: string;
  /** The compose file (or its folder); empty: the one Portplane found. */
  file?: string;
}

export interface ComposePlan {
  op: ComposeOp;
  project?: string;
  title: string;
  summary: string;
  file?: string;
  dir: string;
  argv: string[];
  terminal: string;
  problem?: string;
}

export interface LanAddress {
  ip: string;
  interface: string;
  default: boolean;
}

export interface LanApp {
  hostname: string;
  url: string;
  label: string;
  kind: "app" | "alias" | "compose";
  machine?: string;
  appId?: string;
}

export interface Mdns {
  supported: boolean;
  tool?: string;
  installed: boolean;
  path?: string;
  package?: string;
  install?: string;
}

export interface LanView {
  os: string;
  mdns: Mdns;
  requirements: Requirement[];
  ready: boolean;
  enabled: boolean;
  responding: boolean;
  ip?: string;
  addresses: LanAddress[];
  apps: LanApp[];
  options: ProxyOptions;
  serviceInstalled: boolean;
  port: number;
  https: boolean;
  ca: CA;
}

export interface SharingApi {
  portlessSharing(): Promise<SharingOverview>;
  /** Saves the ngrok authtoken with `ngrok config add-authtoken`; resolves with the new overview. */
  portlessNgrokAuthtoken(token: string): Promise<SharingOverview>;
  portlessShareInfo(machine: string, app: string): Promise<ShareInfo>;
  portlessSharePreview(machine: string, app: string, kind: ShareKind, on: boolean): Promise<SharePreview>;
  /** Applies the previewed change; a public share needs confirmPublic. 409 when the file changed. */
  portlessShare(machine: string, app: string, kind: ShareKind, on: boolean, digest: string, confirmPublic: boolean): Promise<Job>;
  portlessCompose(): Promise<ComposeOverview>;
  portlessComposePreview(req: ComposeRequest): Promise<ComposePlan>;
  portlessComposeRun(req: ComposeRequest): Promise<Job>;
  portlessLan(): Promise<LanView>;
}

export function createSharingHttp(h: Http): SharingApi {
  const { json } = h;
  return {
    portlessSharing: () => json<SharingOverview>("GET", "/api/portless/sharing"),
    portlessNgrokAuthtoken: (token) => json<SharingOverview>("POST", "/api/portless/sharing/ngrok-authtoken", { token }),
    portlessShareInfo: (machine, app) => json<ShareInfo>("GET", `/api/portless/share?${new URLSearchParams({ machine, app })}`),
    portlessSharePreview: (machine, app, kind, on) => json<SharePreview>("POST", "/api/portless/share/preview", { machine, app, kind, on }),
    portlessShare: (machine, app, kind, on, digest, confirmPublic) => json<Job>("POST", "/api/portless/share/apply", { machine, app, kind, on, digest, confirmPublic }),
    portlessCompose: () => json<ComposeOverview>("GET", "/api/portless/compose"),
    portlessComposePreview: (req) => json<ComposePlan>("POST", "/api/portless/compose/preview", req),
    portlessComposeRun: (req) => json<Job>("POST", "/api/portless/compose/run", req),
    portlessLan: () => json<LanView>("GET", "/api/portless/lan"),
  };
}
