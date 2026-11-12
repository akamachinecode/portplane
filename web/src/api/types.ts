// Mirror of internal/model (Go). Keep both in sync: the Go types are the
// source of truth, and remote agents send the same JSON (ADR-0005).

export type State = "on" | "starting" | "stopping" | "failed" | "off" | "done" | "unknown";
export type Verb = "start" | "stop" | "restart";

export interface Target {
  machine: string;
  runner: string;
  task?: string;
  prefix?: string;
  tasks?: string[];
}

export interface App {
  id: string;
  runner: string;
  task: string;
  label: string;
  kind: "service" | "job";
  project: string;
  worktree?: string;
  dir?: string;
  command?: string[];
  deps?: string[];
  state: State;
  rawState?: string;
  detail?: string;
  url?: string;
  hostname?: string;
  port?: number;
  ports?: number[];
  pid?: number;
  order: number;
  remoteUrl?: string;
}

export interface Port {
  port: number;
  address: string;
  pid?: number;
  process?: string;
  dir?: string;
  project?: string;
  inFolder: boolean;
  url?: string;
  route?: string;
}

export interface Runner {
  root: string;
  name: string;
  up: boolean;
  error?: string;
}

export interface Tools {
  dekit?: string;
  portless?: string;
  proxyRunning: boolean;
  proxyHttps: boolean;
  proxyPort?: number;
}

export interface Machine {
  id: string;
  name: string;
  local: boolean;
  hostname?: string;
  os?: string;
  arch?: string;
  status: "online" | "connecting" | "offline";
  error?: string;
  agent?: string;
}

export interface Worktree {
  name: string; // empty for the main checkout
  prefix?: string;
  running: number;
  apps: string[];
}

export interface Project {
  name: string;
  runner: string;
  prefix?: string; // shared task path prefix, for project-wide actions
  running: number; // services alive (jobs excluded)
  total: number; // every app, jobs included
  worktrees: Worktree[];
}

export interface MachineSnapshot {
  machine: Machine;
  tools: Tools;
  folders: string[];
  runners: Runner[];
  apps: App[];
  otherPorts: Port[];
  projects: Project[];
  updatedAt: string;
}

export interface Snapshot {
  machines: MachineSnapshot[];
  version: number;
}

export interface Excerpt {
  lines: string[];
  command: string; // the dekit command that shows the full screen
}

export interface Settings {
  folders: string[];
}

export interface Info {
  version: string;
  os: string;
  arch: string;
  url: string; // the stable URL of this UI, if portless is available
  picker: boolean; // a native folder picker is available (POST /api/folders/pick)
}

// ---- Setup (internal/setup, internal/server/setup.go and tools.go) ----

/** The checks of GET /api/setup/check, in the order the server lists them. */
export type RequirementId =
  | "dekit"
  | "node"
  | "portless"
  | "git"
  | "packages"
  | "port"
  | "proxy"
  | "ca"
  | "hosts"
  | "lan"
  | "path"
  | "tray"
  | "portplane";

/** ok, missing, outdated, warning, info, or skipped (the check does not apply here). */
export type RequirementStatus = "ok" | "missing" | "outdated" | "warning" | "info" | "skipped";

/** What Portplane itself can do about a requirement (M5.1). */
export type RequirementFix =
  | "install-dekit"
  | "install-node"
  | "install-portless"
  | "update-dekit"
  | "update-portless"
  | "proxy"
  | "reinstall-service"
  | "use-1355"
  | "trust-system"
  | "trust-browsers"
  | "path-profile";

/** One thing setup checks, with how to fix it by hand (commands) or from Portplane (fix). */
export interface Requirement {
  id: RequirementId;
  name: string;
  why: string;
  ok: boolean;
  /** Older binaries leave it out: statusOf() in lib/setup.ts derives it. */
  status?: RequirementStatus;
  version?: string;
  detail?: string; // what was found
  problem?: string;
  commands?: string[]; // copyable, in order
  docs?: string;
  privilege: boolean; // the step needs an administrator
  optional?: boolean; // setup works without it
  fix?: RequirementFix;
  origin?: import("./tools").ToolOrigin;
  install?: import("./tools").InstallPlan;
  port?: import("./tools").PortInfo;
  service?: import("./tools").ServiceInfo;
  browsers?: import("./tools").BrowserReport;
  managers?: Record<string, string>; // package manager -> version ("" missing)
  path?: import("./tools").PathStatus;
}

export interface SetupCheck {
  requirements: Requirement[];
  ready: boolean; // everything needed to write and run config
  /** How this computer asks for the admin password: pkexec, osascript, uac, or "" (none: run it in a terminal). */
  admin?: string;
  os?: string;
}

export type ProposalStatus = "new" | "unchanged" | "changed" | "manual" | "skipped";

export interface AppProposal {
  task: string; // dekit task path
  project: string;
  worktree?: string;
  name: string; // the portless name (hostname without .localhost)
  hostname: string;
  dir: string; // relative to the folder
  package?: string;
  framework: string;
  packageManager: string;
  command: string[];
  status: ProposalStatus;
  skipped: boolean;
  notes?: string[];
}

export interface ProposalChange {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface FileChange {
  path: string; // absolute
  before: string;
  after: string;
  created: boolean;
  changed: boolean;
}

/** A project setup found but can't write tasks for yet (not JavaScript or TypeScript). */
export interface UnsupportedProject {
  project: string;
  dir: string; // relative to the folder
  kinds: string[]; // "Python", "Go", "Docker Compose"…
}

export interface Proposal {
  folder: string;
  /** The dekit project the tasks join (the folder, or the project above it). */
  root?: string;
  apps: AppProposal[];
  /** Older binaries leave it out. */
  unsupported?: UnsupportedProject[];
  warnings: string[];
  change: ProposalChange;
  files: FileChange[];
  digest: string; // apply only what was reviewed
}

/** The user's edits to a proposal, keyed by task path. */
export interface SetupOverrides {
  names?: Record<string, string>; // task -> portless name
  skip?: Record<string, boolean>;
}

export interface ApplyResult {
  written: string[];
  reloaded: boolean;
  reloadError?: string;
}

// ---- Remote machines (internal/settings, internal/remote) ----

/** A machine as saved in settings. */
export interface MachineSettings {
  id: string; // stable id, also the URL label
  name: string;
  host: string; // ssh destination: a ~/.ssh/config alias or user@host
  folders: string[];
}

export interface MachineCandidate {
  host: string; // what to pass to ssh
  name: string;
  source: "ssh-config" | "tailscale";
  os?: string;
  online?: boolean;
}

export interface NewMachine {
  host: string;
  name: string;
  folders: string[];
}

export interface MachineUpdate {
  name?: string;
  folders: string[];
}

// ---- Start at login ----

export interface Autostart {
  enabled: boolean;
}

// ---- Preferences (GET and PUT /api/preferences; lib/preferences.ts) ----

export type Theme = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

export interface OnboardingProgress {
  completed: boolean;
  skipped: boolean;
  step?: string;
  done: string[]; // steps finished
  /** What the user picked on the way, such as proxy: "service" | "unprivileged". */
  choices?: Record<string, string>;
}

/** How the user likes the app. PUT sends the whole object back. */
export interface Preferences {
  theme: Theme;
  density: Density;
  favorites: string[]; // "<machine>|<appId>"
  notifications: { failures: boolean; recoveries: boolean; jobs: boolean };
  updateCheck: "manual" | "auto";
  onboarding: OnboardingProgress;
}
