import type { RunnerInfo, RunnerState, TaskChange, Why, WhyDep } from "../../api/dekit";
import type { App } from "../../api/types";

// Plain-English readings of dekit's states (plan §4.2, §4.3): nothing
// dekit says is dropped, but each piece reads as a sentence.

/** dekit's own state word with how the last run ended: "exited (code 3)", "backoff (not ready in time)". */
export function rawStateText(s: { state: string; exit_code?: number; signal?: string | number; reason?: string }): string {
  const how: string[] = [];
  if (s.reason === "ready_timeout") how.push("not ready in time");
  else if (s.reason === "kill_timeout") how.push("stop timed out");
  else if (s.signal !== undefined && s.signal !== null && s.signal !== "") how.push(`signal ${signalName(s.signal)}`);
  else if (s.exit_code !== undefined && s.exit_code !== null && s.state !== "done") how.push(`code ${s.exit_code}`);
  return how.length ? `${s.state} (${how.join(", ")})` : s.state;
}

const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL", 13: "SIGPIPE", 15: "SIGTERM" };

export function signalName(sig: string | number): string {
  if (typeof sig === "number") return SIGNALS[sig] ?? String(sig);
  return /^\d+$/.test(sig) ? (SIGNALS[Number(sig)] ?? sig) : sig;
}

export type Mark = { id: "pinned" | "vetoed" | "needed" | "retrying" | "dynamic"; label: string; detail: string };

/** The marks plan §4.2 asks for: pinned, kept stopped, needed by, restart attempts. */
export function whyMarks(w: Why, app?: Pick<App, "dynamic">): Mark[] {
  const out: Mark[] = [];
  if (w.pinned) out.push({ id: "pinned", label: "Started by you", detail: "You started it, so it stays up until you stop it, even when nothing else needs it." });
  if (w.vetoed) out.push({ id: "vetoed", label: "Kept stopped", detail: "dekit won't start it, even when another app needs it, until you start it again." });
  if (w.required_by.length) out.push({ id: "needed", label: `Needed by ${listWords(w.required_by)}`, detail: "These depend on it, so starting them starts it too." });
  if (w.attempts > 0) out.push({ id: "retrying", label: `${w.attempts} restart ${w.attempts === 1 ? "attempt" : "attempts"}`, detail: "dekit restarted it after it stopped on its own (autorestart)." });
  if (app?.dynamic) out.push({ id: "dynamic", label: "Run once", detail: "Added with Run a command; it isn't in any config file." });
  return out;
}

export function listWords(items: string[], max = 3): string {
  if (items.length <= max) return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items.join("");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

const ALIVE = new Set(["running", "ready", "starting"]);

/** One sentence: why the task is where it is. */
export function whySentence(w: Why): string {
  const waiting = w.deps.filter((d) => d.wanted && !d.satisfied);
  if (w.vetoed) return "It's kept stopped: dekit won't start it until you start it yourself.";
  if (w.state === "backoff") return `It stopped (${rawStateText(w).replace(/^backoff \(|\)$/g, "")}) and dekit will start it again${w.attempts ? ` (attempt ${w.attempts + 1})` : ""}.`;
  if (w.wanted && !w.supported && waiting.length) return `Waiting for ${waiting.map(depText).join(", ")}.`;
  if (w.state === "starting") return "Starting: dekit is waiting for its ready check.";
  if (w.state === "ready") return w.pinned ? "Running and ready. You started it." : `Running and ready${w.required_by.length ? `, because ${listWords(w.required_by)} ${w.required_by.length === 1 ? "needs" : "need"} it` : ""}.`;
  if (w.state === "running") return "Running.";
  if (w.state === "stopping") return "Stopping.";
  if (w.state === "done") return "Finished successfully.";
  if (w.state === "exited") return `It exited (${rawStateText(w).replace(/^exited \(|\)$/g, "") || "no code"})${w.wanted ? " and nothing restarts it" : ""}.`;
  if (w.state === "idle" && w.reason === "kill_timeout") return "Stopped, but its process outlived the stop: dekit gave up waiting.";
  if (w.state === "idle") return w.required_by.length ? `Stopped. It starts when ${listWords(w.required_by)} ${w.required_by.length === 1 ? "starts" : "start"}.` : "Stopped. Nothing needs it.";
  return rawStateText(w);
}

export function depText(d: WhyDep): string {
  return `${d.path} (${rawStateText(d)})`;
}

export function depTone(d: WhyDep): "on" | "starting" | "failed" | "off" {
  if (d.satisfied) return "on";
  if (ALIVE.has(d.state) || d.state === "stopping") return "starting";
  if (d.state === "exited" || d.state === "backoff") return "failed";
  return "off";
}

// ---- runners ----

export const RUNNER_STATE_LABEL: Record<RunnerState, string> = {
  running: "Running",
  starting: "Starting",
  stale: "Stale record",
  failed: "Failed",
  absent: "Not running",
};

export function runnerTone(r: Pick<RunnerInfo, "state">): "on" | "starting" | "failed" | "off" {
  switch (r.state) {
    case "running":
      return "on";
    case "starting":
      return "starting";
    case "failed":
      return "failed";
    // a stale record is a leftover: nothing runs and nothing failed now (Health lists it as a note)
    default:
      return "off";
  }
}

/** "for 3 days", "for 2 hours", "for a minute". */
export function sinceText(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "for less than a minute";
  if (min < 60) return `for ${min === 1 ? "a minute" : `${min} minutes`}`;
  const h = Math.floor(min / 60);
  if (h < 48) return `for ${h === 1 ? "an hour" : `${h} hours`}`;
  return `for ${Math.floor(h / 24)} days`;
}

// ---- reload plans ----

/** dekit's task keys in the words the task form uses; anything else keeps its key. */
const FIELD_WORDS: Record<string, string> = {
  cmd: "command",
  script: "script",
  cwd: "folder",
  env: "environment",
  add_path: "PATH",
  deps: "dependencies",
  tags: "tags",
  label: "label",
  type: "kind",
  autostart: "start with the project",
  autorestart: "restart",
  ready: "ready check",
  stop: "stop",
  scrollback_len: "lines kept",
  log: "output file",
};

/** What a reload does to one task, in words. */
export function changeText(c: TaskChange): string {
  switch (c.kind) {
    case "added":
      return c.apply ? "New in the config: added, stopped until started" : "New in the config";
    case "removed":
      return c.apply ? "Gone from the config: removed" : c.reason === "running" ? "Gone from the config, but it's running: kept until you stop it" : `Gone from the config: kept (${c.reason ?? "changed here"})`;
    default: {
      const words = (c.fields ?? []).map((f) => FIELD_WORDS[f.key] ?? f.key).join(", ");
      const conflict = (c.fields ?? []).some((f) => f.conflict);
      const what = words ? words.charAt(0).toUpperCase() + words.slice(1) : "Settings";
      return `${what} changed${conflict ? " here and in the file: kept as it runs" : ""}`;
    }
  }
}

/** Tasks a reload changes that run now, so "Apply and restart" restarts them. */
export function affectedRunning(changes: TaskChange[], apps: Pick<App, "task" | "state">[]): string[] {
  const alive = new Set(apps.filter((a) => a.state === "on" || a.state === "starting").map((a) => a.task));
  return changes.filter((c) => c.kind === "changed" && c.apply && alive.has(c.path)).map((c) => c.path);
}
