import type { Http } from "./http";
import type { Job } from "./jobs";
import type { FileChange } from "./types";

// The dekit part of the API (plan §4, M5.3): runners, why, the config
// editor with reload review, one-off commands, adding an app by hand and
// dekit itself. Mirror of internal/server/dekit.go and internal/dekit:
// keep both in sync. Everything here acts on this computer; task actions
// (kill, veto, remove) go through Api.act so they work on every machine.

/** dekit's word for a runner: running, starting, stale (its process is gone), failed or absent. */
export type RunnerState = "running" | "starting" | "stale" | "failed" | "absent";

export interface RunnerInfo {
  /** The project's folder, or "host" for this computer's runner. */
  root: string;
  name: string;
  kind: "project" | "host";
  state: RunnerState;
  pid?: number;
  version?: string;
  binary?: string;
  selectedBinary?: string;
  selectionError?: string;
  /** The project now selects another dekit: a restart (or upgrade) switches. */
  restartRequired: boolean;
  /** RFC 3339. */
  since?: string;
  warnings: string[];
  /** In a folder Portplane watches. */
  watched: boolean;
  config?: string;
  configExists: boolean;
  error?: string;
}

export interface RunnersResponse {
  available: boolean;
  runners: RunnerInfo[];
  host: RunnerInfo;
  stale: number;
  /** dekit can restart and upgrade runners in place (not on Windows). */
  live: boolean;
}

export type RunnerAction = "up" | "down" | "stop" | "restart" | "upgrade";

export interface WhyDep {
  path: string;
  state: string;
  exit_code?: number;
  signal?: string | number;
  reason?: string;
  wanted: boolean;
  satisfied: boolean;
}

/** `dekit why --json`: why a task is (not) running. */
export interface Why {
  id: number;
  path: string;
  state: string;
  exit_code?: number;
  signal?: string | number;
  reason?: string;
  wanted: boolean;
  supported: boolean;
  vetoed: boolean;
  pinned: boolean;
  required_by: string[];
  deps: WhyDep[];
  attempts: number;
}

/** A value as written in dekit.yaml; a !js value is {"$js": source}. */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export interface ConfigFileInfo {
  path: string;
  rel: string;
  role: "main" | "fragment" | "portplane";
  at?: string;
  exists: boolean;
  digest: string;
  content: string;
  editable: boolean;
  problem?: string;
}

export interface TaskEntry {
  path: string;
  key: string;
  file: string;
  folder: boolean;
  line: number;
  values: Record<string, YamlValue>;
  editable: boolean;
  problem?: string;
}

export interface LoadEntry {
  file: string;
  at?: string;
  line: number;
}

export interface ProjectConfig {
  root: string;
  file: string;
  files: ConfigFileInfo[];
  tasks: TaskEntry[];
  load: LoadEntry[];
  /** The main file's other top-level keys as written: defaults, vars, kernel, log, on_init, on_idle. */
  settings: Record<string, YamlValue>;
  /** The same entries as they appear in the file, for editing as text. */
  text: Record<string, string>;
  fragment: string;
  warnings: string[];
}

/** One change to a config file (internal/dekit EditOp). */
export type EditOp =
  | { op: "set"; path: string[]; key: string; value: YamlValue }
  | { op: "unset"; path: string[]; key: string }
  | { op: "insert"; path: string[]; key: string; value: YamlValue; after?: string; before?: string }
  | { op: "delete"; path: string[] }
  | { op: "rename"; path: string[]; to: string }
  | { op: "move"; path: string[]; before?: string; after?: string }
  | { op: "text"; path: string[]; text: string }
  | { op: "replace"; text: string }
  | { op: "load"; file: string; at?: string };

export interface ConfigProblem {
  path: string;
  line?: number;
  message: string;
}

export interface FieldChange {
  key: string;
  base: unknown;
  here: unknown;
  config: unknown;
  conflict: boolean;
  take: boolean;
}

export interface TaskChange {
  path: string;
  kind: "changed" | "added" | "removed";
  apply: boolean;
  reason?: string;
  fields?: FieldChange[];
}

export interface ReloadPlan {
  changes: TaskChange[];
  edited_here: string[];
  order?: { apply: boolean; conflict: boolean };
}

export interface Reload {
  applied: boolean;
  errors: string[];
  plan: ReloadPlan;
}

export interface FileEdit extends FileChange {
  digest: string;
}

export interface EditResult {
  files: FileEdit[];
  problems: ConfigProblem[];
  warnings: string[];
  written: boolean;
  up: boolean;
  reload?: Reload;
  reloadError?: string;
}

export interface EditRequest {
  runner: string;
  /** Absolute, or "portplane" for Portplane's fragment (created and loaded when missing). */
  file: string;
  digests?: Record<string, string>;
  ops: EditOp[];
  write: boolean;
}

export interface ReloadResponse {
  up: boolean;
  reload?: Reload;
  error?: string;
  restarted: string[];
}

export interface SpawnSpec {
  path: string;
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  deps?: string[];
  tags?: string[];
}

export interface ReadySuggestion {
  log?: string;
  tcp?: number;
  http?: string;
}

export interface Suggestion {
  id: string;
  label: string;
  source: string;
  lang: "node" | "python" | "go" | "ruby" | "php" | "docker" | "procfile";
  cmd: string[];
  wrap: boolean;
  port?: number;
  ready?: ReadySuggestion;
  job?: boolean;
  note?: string;
}

export interface SuggestResponse {
  suggestions: Suggestion[];
  /** The dekit project above the folder, if any. */
  project: string;
}

export interface NewApp {
  path: string;
  label?: string;
  folder: string;
  cmd: string[];
  job?: boolean;
  name?: string;
  wrap?: boolean;
  port?: number;
  ready?: ReadySuggestion;
  deps?: string[];
  autostart?: boolean;
}

export interface AddAppRequest {
  runner: string;
  app: NewApp;
  target: "portplane" | "main";
  digests?: Record<string, string>;
  write: boolean;
}

export interface Origin {
  kind: "script" | "homebrew" | "npm" | "pip" | "cargo" | "other";
  receipt?: string;
  update: string[];
  upgradeRunners: boolean;
}

export interface KernelStatus {
  selected: string;
  active: string | null;
  default: string | null;
  restart_required: boolean;
  selection_error: string | null;
}

export interface DekitAbout {
  installed: boolean;
  version?: string;
  path?: string;
  origin: Origin;
  kernel?: KernelStatus;
  kernelError?: string;
  os: string;
}

// ---- dekit help --json ----

export type HelpInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong" | "em"; children: HelpInline[] }
  | { type: "tag-link"; tag: string }
  | { type: "url-link"; href: string; children: HelpInline[] };

export interface HelpFieldItem {
  kind: "config" | "cli-flag" | "js";
  key: string;
  desc: string;
  topic: string;
  type?: string;
  default?: string;
}

export type HelpBlock =
  | { type: "paragraph" | "footnote"; inlines: HelpInline[] }
  | { type: "heading"; level: number; id: string; inlines: HelpInline[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "list"; ordered: boolean; items: HelpInline[][] }
  | { type: "callout"; variant: string; title: string | null; blocks: HelpBlock[] }
  | { type: "fields"; kind: string; items: HelpFieldItem[] }
  | { type: "commands"; items: Array<{ cmd: string; desc: string; topic: string }> };

export interface HelpTopic {
  id: string;
  title: string;
  section: string;
  summary: string;
  related: string[];
  headings: Array<{ id: string; level: number; text: string }>;
  blocks: HelpBlock[];
}

export interface DekitHelp {
  dekit: string;
  home: string;
  topics: HelpTopic[];
  nav: Array<{ id: string; title: string; topics: string[] }>;
  /** "config/tasks#ready" → the topic and the heading it points at. */
  tags: Record<string, { topic: string; heading?: string }>;
  fields: HelpFieldItem[];
}

export interface DekitApi {
  dekitRunners(): Promise<RunnersResponse>;
  /** Starts a job (up waits until the tasks are ready). */
  dekitRunnerAction(root: string, action: RunnerAction): Promise<Job>;
  dekitCleanRunners(): Promise<void>;
  dekitUpgradeAll(): Promise<Job>;
  dekitWhy(runner: string, task: string): Promise<Why>;
  dekitConfig(runner: string): Promise<ProjectConfig>;
  /** Previews (write: false) or writes an edit; 409 when a file changed since it was read. */
  dekitEdit(req: EditRequest): Promise<EditResult>;
  dekitValidate(content: string): Promise<ConfigProblem[]>;
  dekitOpenFile(runner: string, file: string): Promise<void>;
  dekitReloadPlan(runner: string): Promise<ReloadResponse>;
  dekitReload(runner: string, restart: boolean): Promise<ReloadResponse>;
  dekitSpawn(runner: string, spec: SpawnSpec): Promise<void>;
  dekitSuggest(folder: string): Promise<SuggestResponse>;
  dekitAddApp(req: AddAppRequest): Promise<EditResult>;
  dekitAbout(): Promise<DekitAbout>;
  /** Registers a default kernel; "" clears it. */
  dekitSetKernel(path: string): Promise<KernelStatus>;
  dekitUpdate(version: string): Promise<Job>;
  dekitHelp(): Promise<DekitHelp>;
}

export function createDekitHttp(h: Http): DekitApi {
  const { json, none } = h;
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  return {
    dekitRunners: () => json<RunnersResponse>("GET", "/api/dekit/runners"),
    dekitRunnerAction: (root, action) => json<Job>("POST", "/api/dekit/runners/action", { root, action }),
    dekitCleanRunners: () => none("POST", "/api/dekit/runners/clean", {}),
    dekitUpgradeAll: () => json<Job>("POST", "/api/dekit/runners/upgrade-all", {}),
    dekitWhy: (runner, task) => json<Why>("GET", `/api/dekit/why?${q({ runner, task })}`),
    dekitConfig: (runner) => json<ProjectConfig>("GET", `/api/dekit/config?${q({ runner })}`),
    dekitEdit: (req) => json<EditResult>("POST", "/api/dekit/config/edit", req),
    dekitValidate: async (content) => (await json<{ problems: ConfigProblem[] }>("POST", "/api/dekit/config/validate", { content })).problems,
    dekitOpenFile: (runner, file) => none("POST", "/api/dekit/config/open", { runner, file }),
    dekitReloadPlan: (runner) => json<ReloadResponse>("GET", `/api/dekit/reload?${q({ runner })}`),
    dekitReload: (runner, restart) => json<ReloadResponse>("POST", "/api/dekit/reload", { runner, restart }),
    dekitSpawn: (runner, spec) => none("POST", "/api/dekit/spawn", { runner, spec }),
    dekitSuggest: (folder) => json<SuggestResponse>("POST", "/api/dekit/suggest", { folder }),
    dekitAddApp: (req) => json<EditResult>("POST", "/api/dekit/apps", req),
    dekitAbout: () => json<DekitAbout>("GET", "/api/dekit/about"),
    dekitSetKernel: (path) => json<KernelStatus>("POST", "/api/dekit/kernel", { path }),
    dekitUpdate: (version) => json<Job>("POST", "/api/dekit/update", { version }),
    dekitHelp: () => json<DekitHelp>("GET", "/api/dekit/help"),
  };
}
