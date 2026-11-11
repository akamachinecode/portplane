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
