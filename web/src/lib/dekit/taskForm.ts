import type { EditOp, TaskEntry, YamlValue } from "../../api/dekit";

// The task form (plan §4.4): a TaskEntry's values as written become a
// draft the form edits; the draft goes back to values, and only the keys
// that changed become edits, so everything else in the file stays as the
// user wrote it.

export type ReadyKind = "none" | "tcp" | "http" | "log" | "cmd" | "file" | "sd_notify";
export type StopMode = "default" | "signal" | "keys" | "cmd";
export type LogMode = "off" | "on" | "custom";
export type Autorestart = "never" | "on-failure" | "always";

export interface EnvRow {
  key: string;
  /** null unsets the variable for the task. */
  value: string | null;
}

export interface TaskDraft {
  label: string;
  mode: "cmd" | "script";
  cmd: string[];
  script: string;
  type: "service" | "job";
  cwd: string;
  env: EnvRow[];
  addPath: string[];
  deps: string[];
  tags: string[];
  ready: { kind: ReadyKind; value: string; interval: string; timeout: string };
  autostart: boolean;
  autorestart: Autorestart;
  stop: { mode: StopMode; signal: string; keys: string[]; cmd: string[]; timeout: string; group: boolean };
  log: { mode: LogMode; dir: string; file: string; fileMode: "" | "append" | "truncate" };
  scrollback: string;
}

/** The keys the form edits; others in the entry stay untouched. */
export const FORM_KEYS = ["label", "cmd", "script", "type", "cwd", "env", "add_path", "deps", "tags", "ready", "autostart", "autorestart", "stop", "log", "scrollback_len"] as const;
export type FormKey = (typeof FORM_KEYS)[number];

/** Keys `defaults:` takes (not type or ready, per dekit help). */
export const DEFAULTS_KEYS: FormKey[] = ["cwd", "env", "add_path", "autostart", "autorestart", "stop", "log", "scrollback_len"];

export function isJs(v: YamlValue | undefined): v is { $js: string } {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>).$js === "string";
}

/** Keys whose value is written with !js: the form shows them read-only. */
export function jsKeys(values: Record<string, YamlValue>): string[] {
  return Object.keys(values).filter((k) => isJs(values[k]) || hasJsInside(values[k]));
}

function hasJsInside(v: YamlValue | undefined): boolean {
  if (isJs(v)) return true;
  if (Array.isArray(v)) return v.some(hasJsInside);
  if (v && typeof v === "object") return Object.values(v).some(hasJsInside);
  return false;
}

const str = (v: YamlValue | undefined): string => (v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v));
const strList = (v: YamlValue | undefined): string[] => (Array.isArray(v) ? v.map((x) => str(x)) : typeof v === "string" ? [v] : []);
const obj = (v: YamlValue | undefined): Record<string, YamlValue> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, YamlValue>) : {});

/** "web" in a fragment mounted at "ops" is "ops/web"; "/x" is the root's x. */
export function fullDep(dep: string, mount: string): string {
  if (dep.startsWith("/")) return dep.slice(1);
  return mount ? `${mount}/${dep}` : dep;
}

export function localDep(dep: string, mount: string): string {
  if (!mount) return dep;
  return dep.startsWith(`${mount}/`) ? dep.slice(mount.length + 1) : `/${dep}`;
}

export function mountOf(entry: Pick<TaskEntry, "path" | "key">): string {
  return entry.path.endsWith(`/${entry.key}`) ? entry.path.slice(0, -entry.key.length - 1) : "";
}

/** Splits a cmd string as dekit does, roughly; the form shows lists. */
function cmdWords(v: YamlValue | undefined): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x));
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  return [];
}

export function toDraft(values: Record<string, YamlValue>, mount = ""): TaskDraft {
  const ready = obj(values.ready);
  const readyKind = (["tcp", "http", "log", "cmd", "file", "sd_notify"] as const).find((k) => k in ready) ?? "none";
  const readyValue = readyKind === "none" || readyKind === "sd_notify" ? "" : readyKind === "cmd" ? cmdWords(ready.cmd).join(" ") : str(ready[readyKind]);
  const stopRaw = values.stop;
  const stop = obj(stopRaw);
  let stopMode: StopMode = "default";
  if (typeof stopRaw === "string") stopMode = "signal";
  else if ("keys" in stop) stopMode = "keys";
  else if ("cmd" in stop) stopMode = "cmd";
  else if ("signal" in stop) stopMode = "signal";
  const logRaw = values.log;
  const log = obj(logRaw);
  let logMode: LogMode = "off";
  if (logRaw === true) logMode = "on";
  else if (typeof logRaw === "string" || (logRaw && typeof logRaw === "object" && !Array.isArray(logRaw))) logMode = log.enabled === false ? "off" : "custom";
  const env = obj(values.env);
  return {
    label: str(values.label),
    mode: values.script !== undefined && values.cmd === undefined ? "script" : "cmd",
    cmd: cmdWords(values.cmd),
    script: str(values.script),
    type: values.type === "job" ? "job" : "service",
    cwd: str(values.cwd),
    env: isJs(values.env) ? [] : Object.keys(env).map((key) => ({ key, value: env[key] === null ? null : str(env[key]) })),
    addPath: strList(values.add_path),
    deps: strList(values.deps).map((d) => fullDep(d, mount)),
    tags: strList(values.tags),
    ready: { kind: readyKind, value: readyValue, interval: str(ready.interval), timeout: str(ready.timeout) },
    autostart: values.autostart === true,
    autorestart: values.autorestart === "on-failure" || values.autorestart === "always" ? values.autorestart : "never",
    stop: {
      mode: stopMode,
      signal: typeof stopRaw === "string" ? stopRaw : str(stop.signal),
      keys: strList(stop.keys),
      cmd: cmdWords(stop.cmd),
      timeout: str(stop.timeout),
      group: stop.group !== false,
    },
    log: {
      mode: logMode,
      dir: str(log.dir),
      file: typeof logRaw === "string" ? logRaw : str(log.file),
      fileMode: log.mode === "append" || log.mode === "truncate" ? log.mode : log.append === true ? "append" : "",
    },
    scrollback: str(values.scrollback_len),
  };
}

export function emptyDraft(): TaskDraft {
  return toDraft({});
}

/** The values the draft stands for, written the way the original was where it can. Undefined: no key. */
export function fromDraft(d: TaskDraft, original: Record<string, YamlValue> = {}, mount = ""): Partial<Record<FormKey, YamlValue>> {
  const out: Partial<Record<FormKey, YamlValue>> = {};
  if (d.label.trim()) out.label = d.label.trim();
  if (d.mode === "cmd") {
    const words = d.cmd.filter((w, i) => w !== "" || i > 0);
    // A string cmd that still splits to the same words stays a string.
    if (typeof original.cmd === "string" && same(cmdWords(original.cmd), words)) out.cmd = original.cmd;
    else if (words.length) out.cmd = words;
  } else if (d.script.trim()) {
    out.script = d.script.trim();
  }
  if (d.type === "job" || original.type === "service") out.type = d.type;
  if (d.cwd.trim()) out.cwd = d.cwd.trim();
  const env = d.env.filter((r) => r.key.trim());
  if (env.length) out.env = Object.fromEntries(env.map((r) => [r.key.trim(), r.value]));
  const addPath = d.addPath.map((p) => p.trim()).filter(Boolean);
  if (addPath.length) out.add_path = addPath;
  if (d.deps.length) out.deps = d.deps.map((x) => localDep(x, mount));
  const tags = d.tags.map((t) => t.trim()).filter(Boolean);
  if (tags.length) out.tags = tags;
  if (d.ready.kind !== "none" && d.type !== "job") {
    const r: Record<string, YamlValue> = {};
    const v = d.ready.value.trim();
    switch (d.ready.kind) {
      case "tcp":
        r.tcp = /^\d+$/.test(v) ? Number(v) : v;
        break;
      case "cmd":
        r.cmd = v.split(/\s+/).filter(Boolean);
        break;
      case "sd_notify":
        r.sd_notify = true;
        break;
      default:
        r[d.ready.kind] = v;
    }
    if (d.ready.interval.trim() && d.ready.kind !== "log" && d.ready.kind !== "sd_notify") r.interval = d.ready.interval.trim();
    if (d.ready.timeout.trim()) r.timeout = d.ready.timeout.trim();
    out.ready = r;
  }
  if (d.autostart) out.autostart = true;
  else if (original.autostart === false) out.autostart = false;
  if (d.autorestart !== "never" || original.autorestart === "never") out.autorestart = d.autorestart;
  const timeout = d.stop.timeout.trim();
  switch (d.stop.mode) {
    case "default":
      if (timeout) out.stop = { timeout };
      break;
    case "signal": {
      const signal = d.stop.signal.trim() || "SIGTERM";
      const s: Record<string, YamlValue> = { signal };
      if (!d.stop.group) s.group = false;
      if (timeout) s.timeout = timeout;
      // The short form (stop: SIGINT) unless the original used an object.
      const short = !timeout && d.stop.group && (original.stop === undefined || typeof original.stop === "string");
      out.stop = short ? signal : s;
      break;
    }
    case "keys":
      out.stop = timeout ? { keys: d.stop.keys, timeout } : { keys: d.stop.keys };
      break;
    case "cmd":
      out.stop = timeout ? { cmd: d.stop.cmd, timeout } : { cmd: d.stop.cmd };
      break;
  }
  switch (d.log.mode) {
    case "on":
      out.log = true;
      break;
    case "custom": {
      const l: Record<string, YamlValue> = {};
      if (d.log.dir.trim()) l.dir = d.log.dir.trim();
      if (d.log.file.trim()) l.file = d.log.file.trim();
      if (d.log.fileMode) l.mode = d.log.fileMode;
      out.log = Object.keys(l).length ? l : true;
      break;
    }
    case "off":
      if (original.log === false || (original.log && typeof original.log === "object" && obj(original.log).enabled === false)) out.log = original.log;
      break;
  }
  if (d.scrollback.trim() !== "") out.scrollback_len = Number(d.scrollback.trim());
  return out;
}

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The edits that turn the entry at path into the draft: a set or unset per
 * form key that changed, never for keys written with !js (read-only), and
 * nothing for keys the form does not know.
 */
export function draftOps(path: string[], original: Record<string, YamlValue>, draft: TaskDraft, mount = "", keys: readonly FormKey[] = FORM_KEYS): EditOp[] {
  const next = fromDraft(draft, original, mount);
  const locked = new Set(jsKeys(original));
  const ops: EditOp[] = [];
  for (const key of keys) {
    if (locked.has(key)) continue;
    const before = original[key];
    const after = next[key];
    if (same(before, after)) continue;
    if (after === undefined) {
      if (before !== undefined) ops.push({ op: "unset", path, key });
    } else {
      ops.push({ op: "set", path, key, value: after });
    }
  }
  return ops;
}

// ---- validation ----

export type DraftErrors = Partial<Record<FormKey | "readyInterval" | "readyTimeout" | "stopTimeout", string>>;

const DURATION = /^[1-9][0-9]*(ms|s|m|h)$/;
const SIGNAL = /^SIG[A-Z0-9]+$/;
export const RESERVED_TAGS = ["autostart", "dynamic"];

export function validDuration(v: string): boolean {
  return DURATION.test(v.trim());
}

/** Problems that stop a save, per field. allTasks: every task path → its deps (full paths), for cycles. */
export function validateDraft(d: TaskDraft, opts: { self?: string; allTasks?: Map<string, string[]>; os?: string; defaults?: boolean } = {}): DraftErrors {
  const e: DraftErrors = {};
  if (!opts.defaults) {
    if (d.mode === "cmd" && (d.cmd.length === 0 || d.cmd[0].trim() === "")) e.cmd = "Enter the program to run.";
    if (d.mode === "script" && !/\.m?js$/.test(d.script.trim())) e.script = "Choose a .js or .mjs file.";
  }
  if (d.type === "job" && d.autorestart === "always") e.autorestart = "A step that runs once can't restart always: choose never or on failure.";
  if (d.type === "job" && d.ready.kind !== "none") e.ready = "A step that runs once has no ready check: it's ready when it's done.";
  for (const t of d.tags) {
    if (RESERVED_TAGS.includes(t.trim())) e.tags = `“${t}” is dekit's own tag${t === "autostart" ? ": use Start with dekit up instead" : ""}.`;
    else if (/\s|[+*?/]/.test(t)) e.tags = `“${t}” can't have spaces, +, * or /.`;
  }
  const keys = d.env.map((r) => r.key.trim()).filter(Boolean);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) e.env = `${dup} is listed twice.`;
  else if (keys.some((k) => /[=\s]/.test(k))) e.env = "A variable name can't have = or spaces.";
  if (d.ready.kind !== "none" && d.ready.kind !== "sd_notify" && !d.ready.value.trim()) e.ready = "Enter what to check, or choose None.";
  if (d.ready.kind === "tcp" && d.ready.value.trim() && !/^(\d{1,5}|[^\s:]+:\d{1,5})$/.test(d.ready.value.trim())) e.ready = "Enter a port such as 3000, or host:port.";
  if (d.ready.kind === "http" && d.ready.value.trim() && !d.ready.value.trim().startsWith("http://")) e.ready = "Enter an http:// URL (dekit checks plain HTTP).";
  if (d.ready.kind === "sd_notify" && opts.os === "windows") e.ready = "sd_notify isn't available on Windows.";
  if (d.ready.interval.trim() && !validDuration(d.ready.interval)) e.readyInterval = "Use a duration such as 500ms, 2s or 1m.";
  if (d.ready.timeout.trim() && !validDuration(d.ready.timeout)) e.readyTimeout = "Use a duration such as 30s or 5m.";
  if (d.stop.timeout.trim() && !validDuration(d.stop.timeout)) e.stopTimeout = "Use a duration such as 10s or 1m.";
  if (d.stop.mode === "signal" && d.stop.signal.trim() && !SIGNAL.test(d.stop.signal.trim())) e.stop = "Use a signal name such as SIGTERM or SIGINT.";
  if (d.stop.mode === "keys" && d.stop.keys.filter(Boolean).length === 0) e.stop = "Enter the keys to type, such as <C-c>.";
  if (d.stop.mode === "cmd" && (d.stop.cmd.length === 0 || !d.stop.cmd[0].trim())) e.stop = "Enter the command that stops it.";
  if (d.scrollback.trim() !== "" && !/^\d+$/.test(d.scrollback.trim())) e.scrollback_len = "Enter a whole number of lines.";
  if (opts.self) {
    if (d.deps.includes(opts.self)) e.deps = "A task can't need itself.";
    else if (opts.allTasks) {
      const missing = d.deps.filter((x) => !opts.allTasks!.has(x));
      if (missing.length) e.deps = `${missing.join(", ")} isn't a task in this project.`;
      const cycle = findCycle(opts.self, d.deps, opts.allTasks);
      if (cycle) e.deps = `That makes a loop: ${cycle.join(" → ")}.`;
    }
  }
  return e;
}

/** A dependency loop through self with these deps, as a path, or null. */
export function findCycle(self: string, deps: string[], all: Map<string, string[]>): string[] | null {
  const graph = new Map(all);
  graph.set(self, deps);
  const seen = new Set<string>();
  const walk = (node: string, path: string[]): string[] | null => {
    for (const next of graph.get(node) ?? []) {
      if (next === self) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(self, [self]);
}

/** Variable names whose values should not show by default. */
export function looksSecret(key: string): boolean {
  return /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH)/i.test(key) && !/^(NODE_EXTRA_CA_CERTS|AUTH_URL|NEXTAUTH_URL)$/i.test(key);
}

/** A path from folder `from` to `to`, with "/" ("../apps/web"); both absolute. */
export function relPath(from: string, to: string): string {
  const win = /^[A-Za-z]:[\\/]/.test(from) || /^[A-Za-z]:[\\/]/.test(to);
  const split = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean);
  const a = split(from);
  const b = split(to);
  if (win && a[0]?.toLowerCase() !== b[0]?.toLowerCase()) return to; // another drive
  let i = 0;
  while (i < a.length && i < b.length && (win ? a[i].toLowerCase() === b[i].toLowerCase() : a[i] === b[i])) i++;
  const rel = [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
  return rel || ".";
}

/** The folder of a file path. */
export function dirOf(file: string): string {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return i > 0 ? file.slice(0, i) : file;
}
