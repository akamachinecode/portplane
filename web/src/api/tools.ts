import type { Http } from "./http";
import type { Job } from "./jobs";
import type { RequirementId, SetupCheck } from "./types";

// Installing tools and the guided setup's other steps (plan §3, M5.1):
// dekit, Node and portless as jobs, the proxy (service with one password,
// or port 1355 without), the CA in the system and in each browser, the
// PATH line and folder suggestions. Mirror of internal/installer,
// internal/browsertrust and internal/server/tools.go: keep both in sync.

export type ToolId = "dekit" | "node" | "portless";

/** How a tool was installed, so it updates the same way (ADR-0019). */
export interface ToolOrigin {
  kind: "script" | "homebrew" | "npm" | "portplane" | "mise" | "fnm" | "volta" | "nvm" | "asdf" | "pip" | "cargo" | "system" | "other";
  label: string;
  path: string;
  target?: string;
  update?: string[];
}

/** What an install will do, shown on its card before the click. */
export interface InstallPlan {
  tool: ToolId;
  method: string;
  version?: string;
  source: string;
  checksum: string;
  destination: string;
  password: boolean;
  steps: string[];
  manual: string[];
  docs?: string;
  alternatives?: Array<{ method: string; label: string; commands: string[] }>;
}

/** Who listens on port 443. */
export interface PortInfo {
  port: number;
  free: boolean;
  portless: boolean;
  pid?: number;
  process?: string;
  known: boolean;
}

/** The proxy and its startup service. */
export interface ServiceInfo {
  installed: boolean;
  responding: boolean;
  running: boolean;
  port?: number;
  https: boolean;
  tlds?: string[];
  lan: boolean;
  nodePath?: string;
  nodeMissing: boolean;
  state?: string;
  installCommand?: string;
}

export type ProfileStatus = "trusted" | "system" | "missing" | "outdated" | "unknown" | "no-ca";

export interface BrowserProfile {
  id: string;
  name: string;
  dir?: string;
  default?: boolean;
  status: ProfileStatus;
  detail?: string;
  canAdd: boolean;
}

export interface Browser {
  id: "firefox" | "chrome" | "chromium" | "brave" | "edge";
  variant?: "snap" | "flatpak";
  name: string;
  store: "nss" | "system";
  profiles: BrowserProfile[];
}

export interface BrowserReport {
  ca?: string;
  caExists: boolean;
  browsers: Browser[];
  certutil?: string;
  certutilHint?: string;
  systemTrusted: boolean;
  p11kit: boolean;
}

/** Whether a terminal finds ~/.local/bin, and the exact line Portplane would add. */
export interface PathStatus {
  dir: string;
  onPath: boolean;
  shell: string;
  file?: string;
  line?: string;
  present: boolean;
}

export interface FolderSuggestion {
  path: string;
  repos: number;
}

/** The proxy's options, as `portless service install` and `proxy start` take them. */
export interface ProxyOptions {
  port: number;
  https: boolean;
  tlds?: string[];
  wildcard: boolean;
  lan: boolean;
  lanIp?: string;
  unprivileged: boolean;
  certPath?: string;
  keyPath?: string;
}

export const DEFAULT_PROXY: ProxyOptions = { port: 443, https: true, tlds: ["localhost"], wildcard: false, lan: false, unprivileged: false };
export const NO_PASSWORD_PROXY: ProxyOptions = { ...DEFAULT_PROXY, port: 1355 };

/** A privileged command as the UI shows it before the click (ADR-0020). */
export interface CommandPreview {
  argv: string[];
  env: Record<string, string>;
  terminal: string;
  /** pkexec, osascript, uac, or "" when no dialog can open here. */
  admin: string;
  needsAdmin: boolean;
}

/** The result of a proxy job. */
export interface ProxyResult {
  url: string;
  answers: boolean;
  caTrusted: boolean;
  loads: boolean;
  terminal: string;
  unprivileged: boolean;
}

export interface ToolsApi {
  /** Some checks only (GET /api/setup/check?only=…), so the UI can show each as it comes. */
  checkSome(ids: RequirementId[]): Promise<SetupCheck>;
  /** Starts an install job (no password). */
  installTool(tool: ToolId, method?: string): Promise<Job>;
  /** The exact `portless service install` for these options, before the click. */
  proxyServicePreview(options: ProxyOptions): Promise<CommandPreview>;
  /** Installs the proxy service through the system's password dialog: a privileged job. */
  installProxyService(options: ProxyOptions): Promise<Job>;
  /** Starts the proxy as the user, on port 1355 by default: no password. */
  startProxy(options?: ProxyOptions): Promise<Job>;
  browserTrust(): Promise<BrowserReport>;
  /** Adds the CA to one browser profile's own certificates. */
  trustBrowser(browser: string, profile: string): Promise<BrowserProfile>;
  /** `portless trust`, and whether it needs the password here (Linux). */
  systemTrustPreview(): Promise<CommandPreview>;
  trustSystem(): Promise<Job>;
  pathProfile(): Promise<PathStatus>;
  /** Writes the line pathProfile showed, after the user agreed. */
  addPathToProfile(): Promise<PathStatus>;
  folderSuggestions(): Promise<FolderSuggestion[]>;
}

export function createToolsHttp(h: Http): ToolsApi {
  const { json } = h;
  return {
    checkSome: (ids) => json<SetupCheck>("GET", `/api/setup/check?${new URLSearchParams({ only: ids.join(",") })}`),
    installTool: (tool, method) => json<Job>("POST", "/api/tools/install", method ? { tool, method } : { tool }),
    proxyServicePreview: (options) => json<CommandPreview>("POST", "/api/proxy/service/preview", { options }),
    installProxyService: (options) => json<Job>("POST", "/api/proxy/service/install", { options }),
    startProxy: (options) => json<Job>("POST", "/api/proxy/start", options ? { options } : {}),
    browserTrust: () => json<BrowserReport>("GET", "/api/trust/browsers"),
    trustBrowser: (browser, profile) => json<BrowserProfile>("POST", "/api/trust/browser", { browser, profile }),
    systemTrustPreview: () => json<CommandPreview>("GET", "/api/trust/system"),
    trustSystem: () => json<Job>("POST", "/api/trust/system", {}),
    pathProfile: () => json<PathStatus>("GET", "/api/path/profile"),
    addPathToProfile: () => json<PathStatus>("POST", "/api/path/profile", {}),
    folderSuggestions: () => json<FolderSuggestion[]>("GET", "/api/folders/suggestions"),
  };
}
