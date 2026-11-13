import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { DekitHelp, EditOp, ProjectConfig, TaskEntry, YamlValue } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";
import { useMachineScope } from "../../components/MachineScope";
import { Switch } from "../../components/Controls";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { joinCommand } from "../../lib/dekit/shell";
import { fieldHelp, taskKey } from "../../lib/dekit/help";
import {
  DEFAULTS_KEYS,
  dirOf,
  draftOps,
  FORM_KEYS,
  isJs,
  mountOf,
  relPath,
  taskLabel,
  toDraft,
  validateDraft,
  type FormKey,
  type LogMode,
  type ReadyKind,
  type StopMode,
  type TaskDraft,
} from "../../lib/dekit/taskForm";
import { FieldHelp, HelpLink, useDekitHelp } from "../runners/DekitHelp";
import { Chips, CommandField, FormRow, KeyValueEditor, ListRows, TaskPicker, taskParent } from "./fields";
import { SaveReview } from "./SaveReview";

// The task form (plan §4.4): every key of a dekit task, with dekit's own
// help, checks before saving, and the save flow of SaveReview. With
// `defaults`, the same form edits defaults: (only the keys it takes).

const READY_OPTIONS: Array<{ value: ReadyKind; label: string; hint: string }> = [
  { value: "none", label: "None", hint: "Ready as soon as it starts." },
  { value: "log", label: "A line of output", hint: "Text its output prints when it's ready, such as “ready in”." },
  { value: "tcp", label: "A port answers", hint: "A port such as 3000, or host:port." },
  { value: "http", label: "A URL answers", hint: "An http:// URL that answers with 2xx or 3xx." },
  { value: "cmd", label: "A command succeeds", hint: "A command that exits with 0 once it's ready." },
  { value: "file", label: "A file appears", hint: "A file, relative to the task's folder." },
  { value: "sd_notify", label: "The program says so", hint: "The program sends READY=1 like a systemd service." },
];

const STOP_OPTIONS: Array<{ value: StopMode; label: string }> = [
  { value: "default", label: "SIGTERM (default)" },
  { value: "signal", label: "Another signal" },
  { value: "keys", label: "Type keys" },
  { value: "cmd", label: "Run a command" },
];

/**
 * A group of fields that folds (ADR-0032): what a task runs and where are
 * open; the rest is folded with a line that says what it holds now. A group
 * opens by itself when one of its fields has a problem.
 */
function Section({ title, summary, level = 4, open: initial = false, problem = false, children }: { title: string; summary?: string; level?: 3 | 4; open?: boolean; problem?: boolean; children: ReactNode }) {
  const Heading = level === 3 ? "h3" : "h4";
  const [open, setOpen] = useState(initial);
  useEffect(() => {
    if (problem) setOpen(true);
  }, [problem]);
  return (
    <details className="form-section" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="form-section-head">
        <Icon name="chevronRight" size={14} className="form-section-chevron" />
        <Heading className="form-section-title">{title}</Heading>
        {!open && summary && <span className="form-section-summary">{summary}</span>}
      </summary>
      <div className="form-section-body">{children}</div>
    </details>
  );
}

const READY_SHORT: Record<ReadyKind, string> = { none: "", log: "ready on a line of output", tcp: "ready when a port answers", http: "ready when a URL answers", cmd: "ready when a command succeeds", file: "ready when a file appears", sd_notify: "ready when it says so" };

/** What "Starting and stopping" holds, in a few words. */
function startSummary(d: TaskDraft, defaults: boolean): string {
  const parts: string[] = [];
  parts.push(d.autostart ? "Starts with the project" : "Starts when asked");
  if (d.autorestart === "on-failure") parts.push("restarts when it fails");
  if (d.autorestart === "always") parts.push("always restarts");
  if (!defaults && d.type === "service" && d.ready.kind !== "none") parts.push(READY_SHORT[d.ready.kind]);
  if (d.stop.mode === "signal" && d.stop.signal.trim()) parts.push(`stops with ${d.stop.signal.trim()}`);
  if (d.stop.mode === "keys") parts.push("stops by typing keys");
  if (d.stop.mode === "cmd") parts.push("stops with a command");
  return parts.join(", ");
}

function outputSummary(d: TaskDraft): string {
  const file = d.log.mode === "off" ? "Not written to a file" : "Also written to a file";
  return d.scrollback.trim() ? `${file}, keeps ${d.scrollback.trim()} lines` : file;
}

function depsSummary(d: TaskDraft, parent: string): string {
  const short = (p: string) => (parent && p.startsWith(parent) ? p.slice(parent.length) : p);
  const needs = d.deps.length ? `Needs ${d.deps.map(short).join(", ")}` : "Needs nothing";
  return d.tags.length ? `${needs}; tags ${d.tags.join(", ")}` : needs;
}

function jsSource(v: YamlValue | undefined): string | undefined {
  if (isJs(v)) return v.$js;
  if (v && typeof v === "object" && JSON.stringify(v).includes('"$js"')) return JSON.stringify(v);
  return undefined;
}

export interface TaskFormProps {
  runner: string;
  config: ProjectConfig;
  /** The task, or null with `defaults` for the defaults: entry. */
  entry: TaskEntry | null;
  defaults?: boolean;
  os?: string;
  /** The level of the form's group titles: 3 under the drawer's h2, 4 (the default) under the task editor's h3. */
  headingLevel?: 3 | 4;
  onSaved(): void;
}

/** The read-only notice for entries Portplane does not rewrite. */
export function NotEditable({ runner, file, reason }: { runner: string; file: string; reason: string }) {
  const { remote } = useMachineScope();
  const { api, toast } = useApp();
  return (
    <div className="form-readonly" role="note">
      <Icon name="info" size={15} />
      <div>
        <p>
          <strong>Read-only here:</strong> {reason}.
        </p>
        <p className="muted">
          {remote ? "Change it as text in the YAML tab, or over SSH; Portplane picks up the change." : "Change it in your editor, or as text in the YAML tab; Portplane picks up the change."}
        </p>
        {!remote && (
          <button type="button" className="btn btn-sm" onClick={() => api.dekitOpenFile(runner, file).catch((err: unknown) => toast.error(errorText(err)))}>
            <Icon name="open" size={13} />
            Open in your editor
          </button>
        )}
      </div>
    </div>
  );
}

export function TaskForm({ runner, config, entry, defaults, os, headingLevel = 4, onSaved }: TaskFormProps) {
  const { api, info } = useApp();
  const { help } = useDekitHelp();
  const original: Record<string, YamlValue> = useMemo(
    () => (defaults ? ((config.settings.defaults as Record<string, YamlValue> | undefined) ?? {}) : (entry?.values ?? {})),
    [config, entry, defaults],
  );
  const mount = entry ? mountOf(entry) : "";
  const file = defaults ? config.file : entry!.file;
  const fileInfo = config.files.find((f) => f.path === file);
  const [draft, setDraft] = useState<TaskDraft>(() => toDraft(original, mount));
  const [reviewing, setReviewing] = useState<EditOp[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  useEffect(() => setDraft(toDraft(original, mount)), [original, mount]);
  const ids = { label: useId(), script: useId(), cwd: useId(), ready: useId(), readyValue: useId(), interval: useId(), timeout: useId(), stop: useId(), signal: useId(), stopTimeout: useId(), log: useId(), logDir: useId(), logFile: useId(), scrollback: useId() };

  const allTasks = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of config.tasks) {
      if (t.folder) continue;
      const deps = Array.isArray(t.values.deps) ? (t.values.deps as YamlValue[]).map(String) : [];
      const tm = mountOf(t);
      m.set(t.path, deps.map((d) => (d.startsWith("/") ? d.slice(1) : tm ? `${tm}/${d}` : d)));
    }
    return m;
  }, [config]);
  const keys: readonly FormKey[] = defaults ? DEFAULTS_KEYS : FORM_KEYS;
  const errors = validateDraft(draft, { self: defaults ? undefined : entry!.path, allTasks, os: os ?? info?.os, defaults });
  const ops = draftOps(defaults ? ["defaults"] : ["tasks", entry!.key], original, draft, mount, keys);
  const dirty = ops.length > 0;
  const hasErrors = Object.keys(errors).length > 0;
  const set = (patch: Partial<TaskDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const flagged = (...keys: Array<keyof typeof errors>) => (showErrors || dirty) && keys.some((k) => !!errors[k]);
  const parent = defaults ? "" : taskParent(entry!.path);
  const err = (k: keyof typeof errors) => (showErrors || dirty ? errors[k] : undefined);
  const h = (key: string, extra?: ReactNode) => (fieldHelp(help, taskKey(key)) || extra ? <FieldHelp help={help as DekitHelp | null} fieldKey={taskKey(key)} extra={extra} /> : undefined);
  const lock = (key: string) => jsSource(original[key]);
  const readOnlyReason = !defaults && entry && !entry.editable ? entry.problem ?? "it's written in a way Portplane doesn't rewrite" : fileInfo && !fileInfo.editable ? fileInfo.problem ?? "this file is written in a style Portplane doesn't rewrite" : null;

  if (readOnlyReason) return <NotEditable runner={runner} file={file} reason={readOnlyReason} />;

  const pickFolder = async () => {
    const res = await api.pickFolder();
    if (res.kind === "picked") set({ cwd: relPath(dirOf(file), res.path) });
  };

  const taskOptions = [...allTasks.keys()]
    .filter((p) => defaults || p !== entry!.path)
    .map((p) => {
      const t = config.tasks.find((x) => x.path === p);
      return { path: p, label: taskLabel(p, t?.values) };
    });

  const save = () => {
    setShowErrors(true);
    if (hasErrors || !dirty) return;
    setReviewing(ops);
  };

  return (
    <form
      className="task-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {fileInfo && (
        <p className="task-form-where">
          <Icon name="file" size={13} />
          <span>
            {defaults ? "defaults: in " : "In "}
            <span className="mono" title={fileInfo.role === "portplane" ? `${fileInfo.path} (the tasks Portplane added)` : fileInfo.path}>
              {fileInfo.rel}
            </span>
          </span>
          <span className="spacer" />
          <HelpLink tag={defaults ? "config" : "config/tasks"} className="link-btn help-link quiet-link">
            <Icon name="book" size={13} />
            {defaults ? "About defaults" : "About tasks"}
          </HelpLink>
        </p>
      )}

      {!defaults && (
        <Section level={headingLevel} title="What it runs" open summary={draft.mode === "cmd" ? joinCommand(draft.cmd.filter(Boolean)) : draft.script} problem={flagged("cmd", "script")}>
          <FormRow label="Label" htmlFor={ids.label} help={h("label")} locked={lock("label")}>
            <input id={ids.label} className="input" value={draft.label} placeholder={entry!.path.split("/").pop()} onChange={(e) => set({ label: e.target.value })} />
          </FormRow>
          <FormRow label="Kind" help={h("type")} locked={lock("type")}>
            <Segmented
              label="Kind"
              value={draft.type}
              onChange={(type) => set({ type })}
              options={[
                { value: "service", label: "Service (keeps running)" },
                { value: "job", label: "Step (runs once)" },
              ]}
            />
          </FormRow>
          <FormRow label="Runs" help={draft.mode === "cmd" ? h("cmd") : h("script")} error={draft.mode === "cmd" ? err("cmd") : err("script")} locked={lock(draft.mode === "cmd" ? "cmd" : "script")}>
            <Segmented
              label="Runs"
              value={draft.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: "cmd", label: "A command" },
                { value: "script", label: "A JavaScript file" },
              ]}
            />
            {draft.mode === "cmd" ? (
              <CommandField value={draft.cmd} onChange={(cmd) => set({ cmd })} label="Command" />
            ) : (
              <input id={ids.script} className="input mono form-gap" value={draft.script} placeholder="scripts/dev.mjs" aria-label="Script" onChange={(e) => set({ script: e.target.value })} />
            )}
          </FormRow>
        </Section>
      )}

      <Section level={headingLevel} title={defaults ? "Shared settings" : "Where"} open={!!defaults} summary={`${draft.cwd.trim() || "The project folder"}${draft.env.length ? `, ${draft.env.length === 1 ? "1 variable" : `${draft.env.length} variables`}` : ""}`} problem={flagged("env")}>
        <FormRow label="Folder" htmlFor={ids.cwd} help={h("cwd", <>Relative to <span className="mono">{fileInfo?.rel ?? "the file"}</span>.</>)} locked={lock("cwd")}>
          <div className="input-row">
            <input id={ids.cwd} className="input mono" value={draft.cwd} placeholder={defaults ? "the project folder" : "the project folder"} spellCheck={false} onChange={(e) => set({ cwd: e.target.value })} />
            {info?.picker && (
              <button type="button" className="btn" onClick={() => void pickFolder()}>
                <Icon name="folder" size={14} />
                Choose…
              </button>
            )}
          </div>
        </FormRow>
        <FormRow label="Environment" help={h("env", "Unset removes a variable the task would get from Portplane, dekit or defaults.")} error={err("env")} locked={lock("env")}>
          <KeyValueEditor value={draft.env} onChange={(env) => set({ env })} label="Environment" />
        </FormRow>
        <FormRow label="Add to PATH" help={h("add_path")} locked={lock("add_path")}>
          <ListRows value={draft.addPath} onChange={(addPath) => set({ addPath })} label="Folder on PATH" placeholder="node_modules/.bin" addLabel="Add folder" />
        </FormRow>
      </Section>

      {!defaults && (
        <Section level={headingLevel} title="Dependencies and tags" summary={depsSummary(draft, parent)} problem={flagged("deps", "tags")}>
          <FormRow label="Needs" help={h("deps")} error={err("deps")} locked={lock("deps")}>
            <TaskPicker value={draft.deps} onChange={(deps) => set({ deps })} options={taskOptions} label="Tasks it needs" near={parent} />
          </FormRow>
          <FormRow label="Tags" help={h("tags")} error={err("tags")} locked={lock("tags")}>
            <Chips value={draft.tags} onChange={(tags) => set({ tags })} label="Tags" />
          </FormRow>
        </Section>
      )}

      <Section level={headingLevel} title="Starting and stopping" summary={startSummary(draft, !!defaults)} problem={flagged("autorestart", "ready", "readyInterval", "readyTimeout", "stop", "stopTimeout")}>
        <FormRow label="Start with dekit up" help={h("autostart")} locked={lock("autostart")}>
          <Switch checked={draft.autostart} onChange={(autostart) => set({ autostart })} label="Start it with the project" />
        </FormRow>
        <FormRow label="Restart on its own" help={h("autorestart")} error={err("autorestart")} locked={lock("autorestart")}>
          <Segmented
            label="Restart on its own"
            value={draft.autorestart}
            onChange={(autorestart) => set({ autorestart })}
            options={[
              { value: "never", label: "Never" },
              { value: "on-failure", label: "When it fails" },
              { value: "always", label: "Always" },
            ]}
          />
        </FormRow>
        {!defaults && draft.type === "service" && (
          <FormRow label="Ready when" htmlFor={ids.ready} help={h("ready", READY_OPTIONS.find((o) => o.value === draft.ready.kind)?.hint)} error={err("ready")} locked={lock("ready")}>
            <select id={ids.ready} className="input" value={draft.ready.kind} onChange={(e) => set({ ready: { ...draft.ready, kind: e.target.value as ReadyKind } })}>
              {READY_OPTIONS.filter((o) => o.value !== "sd_notify" || (os ?? info?.os) !== "windows").map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {draft.ready.kind !== "none" && draft.ready.kind !== "sd_notify" && (
              <input
                id={ids.readyValue}
                className="input mono form-gap"
                aria-label="What to check"
                value={draft.ready.value}
                placeholder={{ log: "ready in", tcp: "3000", http: "http://127.0.0.1:3000/health", cmd: "pg_isready", file: ".ready" }[draft.ready.kind]}
                onChange={(e) => set({ ready: { ...draft.ready, value: e.target.value } })}
              />
            )}
            {draft.ready.kind !== "none" && (
              <div className="form-inline form-gap">
                {draft.ready.kind !== "log" && draft.ready.kind !== "sd_notify" && (
                  <label className="form-inline-field">
                    <span>Check every</span>
                    <input id={ids.interval} className="input mono input-short" value={draft.ready.interval} placeholder="1s" aria-invalid={!!err("readyInterval") || undefined} onChange={(e) => set({ ready: { ...draft.ready, interval: e.target.value } })} />
                  </label>
                )}
                <label className="form-inline-field">
                  <span>Give up after</span>
                  <input id={ids.timeout} className="input mono input-short" value={draft.ready.timeout} placeholder="no limit" aria-invalid={!!err("readyTimeout") || undefined} onChange={(e) => set({ ready: { ...draft.ready, timeout: e.target.value } })} />
                </label>
              </div>
            )}
            {(err("readyInterval") || err("readyTimeout")) && <p className="field-error">{err("readyInterval") ?? err("readyTimeout")}</p>}
          </FormRow>
        )}
        <FormRow label="Stop by" htmlFor={ids.stop} help={h("stop")} error={err("stop") ?? err("stopTimeout")} locked={lock("stop")}>
          <select id={ids.stop} className="input" value={draft.stop.mode} onChange={(e) => set({ stop: { ...draft.stop, mode: e.target.value as StopMode } })}>
            {STOP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {draft.stop.mode === "signal" && (
            <input id={ids.signal} className="input mono form-gap" aria-label="Signal" value={draft.stop.signal} placeholder="SIGINT" onChange={(e) => set({ stop: { ...draft.stop, signal: e.target.value.toUpperCase() } })} />
          )}
          {draft.stop.mode === "keys" && <Chips value={draft.stop.keys} onChange={(keys) => set({ stop: { ...draft.stop, keys } })} label="Keys to type" suggestions={["<C-c>", "q", "<Enter>"]} />}
          {draft.stop.mode === "cmd" && <CommandField value={draft.stop.cmd} onChange={(cmd) => set({ stop: { ...draft.stop, cmd } })} label="Stop command" placeholder="pnpm run stop" />}
          <div className="form-inline form-gap">
            <label className="form-inline-field">
              <span>Kill after</span>
              <input id={ids.stopTimeout} className="input mono input-short" value={draft.stop.timeout} placeholder="10s" onChange={(e) => set({ stop: { ...draft.stop, timeout: e.target.value } })} />
            </label>
            {(draft.stop.mode === "signal" || draft.stop.mode === "default") && (
              <label className="form-inline-field">
                <input type="checkbox" checked={draft.stop.group} onChange={(e) => set({ stop: { ...draft.stop, group: e.target.checked, mode: draft.stop.mode === "default" && !e.target.checked ? "signal" : draft.stop.mode } })} />
                <span>Also its child processes</span>
              </label>
            )}
          </div>
        </FormRow>
      </Section>

      <Section level={headingLevel} title="Output" summary={outputSummary(draft)} problem={flagged("scrollback_len")}>
        <FormRow label="Write to a file" htmlFor={ids.log} help={h("log")} locked={lock("log")}>
          <select id={ids.log} className="input" value={draft.log.mode} onChange={(e) => set({ log: { ...draft.log, mode: e.target.value as LogMode } })}>
            <option value="off">No</option>
            <option value="on">Yes, where dekit puts logs</option>
            <option value="custom">Yes, in a folder or file I choose</option>
          </select>
          {draft.log.mode === "custom" && (
            <div className="form-inline form-gap">
              <label className="form-inline-field">
                <span>Folder</span>
                <input id={ids.logDir} className="input mono" value={draft.log.dir} placeholder="logs" onChange={(e) => set({ log: { ...draft.log, dir: e.target.value } })} />
              </label>
              <label className="form-inline-field">
                <span>File</span>
                <input id={ids.logFile} className="input mono" value={draft.log.file} placeholder="web.log" onChange={(e) => set({ log: { ...draft.log, file: e.target.value } })} />
              </label>
              <label className="form-inline-field">
                <span>On start</span>
                <select className="input" value={draft.log.fileMode} onChange={(e) => set({ log: { ...draft.log, fileMode: e.target.value as TaskDraft["log"]["fileMode"] } })}>
                  <option value="">dekit's default</option>
                  <option value="append">Add to the file</option>
                  <option value="truncate">Start the file over</option>
                </select>
              </label>
            </div>
          )}
        </FormRow>
        <FormRow label="Lines to keep" htmlFor={ids.scrollback} help={h("scrollback_len")} error={err("scrollback_len")} locked={lock("scrollback_len")}>
          <input id={ids.scrollback} className="input mono input-short" inputMode="numeric" value={draft.scrollback} placeholder="1000" onChange={(e) => set({ scrollback: e.target.value })} />
        </FormRow>
      </Section>

      {(dirty || (showErrors && hasErrors)) && (
        <div className="form-actions">
          <span className="form-dirty" role="status">{showErrors && hasErrors ? "Fix the fields with a problem first." : ops.length === 1 ? "1 change not saved" : `${ops.length} changes not saved`}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => (setDraft(toDraft(original, mount)), setShowErrors(false))}>
            Discard
          </button>
          <button type="submit" className="btn btn-primary" disabled={!dirty}>
            Review and save…
          </button>
        </div>
      )}

      {reviewing && (
        <SaveReview
          title={defaults ? "Save defaults" : `Save ${entry!.path}`}
          runner={runner}
          folder={config.root === "host" ? dirOf(config.file) : config.root}
          run={(write) => api.dekitEdit({ runner, file, digests: fileInfo?.digest ? { [file]: fileInfo.digest } : undefined, ops: reviewing, write })}
          onClose={() => setReviewing(null)}
          onSaved={onSaved}
        />
      )}
    </form>
  );
}
