import { useId, useState, type ReactNode } from "react";
import type { EditOp, ProjectConfig, YamlValue } from "../../api/dekit";
import { useApp } from "../../components/AppContext";
import { Field } from "../../components/Controls";
import { Icon } from "../../components/Icon";
import { fieldHelp } from "../../lib/dekit/help";
import { isJs, same } from "../../lib/dekit/taskForm";
import { FieldHelp, HelpLink, useDekitHelp } from "../runners/DekitHelp";
import { SaveReview } from "./SaveReview";
import { digestOf } from "./TasksPanel";
import { TaskForm } from "./TaskForm";

// The project's own settings (plan §4.5): defaults with the task form,
// the kernel pin, the runner's log, on_init/on_idle hooks with dekit's
// verbs, fragments under load:, and vars as text.

const HOOK_VERBS = ["up", "start", "stop", "kill", "veto", "restart", "force-restart", "down", "quit"] as const;
const TARGET_VERBS = new Set(["start", "stop", "kill", "veto", "restart", "force-restart"]);
const LOG_LEVELS = ["off", "error", "warn", "info", "debug", "trace"];

function Card({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-card" aria-labelledby={id}>
      <h4 className="settings-card-title" id={id}>
        {title}
      </h4>
      {help && <p className="settings-card-help">{help}</p>}
      {children}
    </section>
  );
}

function KernelCard({ value, onSave }: { value: YamlValue | undefined; onSave(op: EditOp): void }) {
  const initial = value === "npm" ? "npm" : value && typeof value === "object" && !Array.isArray(value) && "path" in value ? "path" : "none";
  const [mode, setMode] = useState<"none" | "npm" | "path">(initial);
  const [path, setPath] = useState(initial === "path" ? String((value as Record<string, YamlValue>).path) : "");
  const id = useId();
  const next: YamlValue | undefined = mode === "npm" ? "npm" : mode === "path" ? { path: path.trim() } : undefined;
  const changed = !same(next, value);
  return (
    <>
      <div className="radio-list" role="radiogroup" aria-label="Kernel">
        {[
          ["none", "The dekit you run, or your default", "What most projects use."],
          ["npm", "The project's own dekit package", "The @dekit/cli package installed in the project, found through Node: everyone on the project runs the same version."],
          ["path", "A binary in the project", "A dekit binary at a path relative to dekit.yaml."],
        ].map(([v, label, hint]) => (
          <label key={v} className="radio-item">
            <input type="radio" name={id} checked={mode === v} onChange={() => setMode(v as typeof mode)} />
            <span>
              <span className="radio-label">{label}</span>
              <span className="radio-hint">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === "path" && (
        <Field label="Binary" htmlFor={`${id}-p`}>
          <input id={`${id}-p`} className="input mono" value={path} placeholder="bin/dekit" onChange={(e) => setPath(e.target.value)} />
        </Field>
      )}
      <div className="settings-card-actions">
        <button type="button" className="btn btn-sm" disabled={!changed || (mode === "path" && !path.trim())} onClick={() => onSave(next === undefined ? { op: "unset", path: [], key: "kernel" } : { op: "set", path: [], key: "kernel", value: next })}>
          Review and save…
        </button>
        <span className="field-hint">A running runner switches when you restart or upgrade it.</span>
      </div>
    </>
  );
}

function LogCard({ value, onSave }: { value: YamlValue | undefined; onSave(op: EditOp): void }) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, YamlValue>) : {};
  const [level, setLevel] = useState(typeof v.level === "string" ? v.level : "");
  const [file, setFile] = useState(typeof v.file === "string" ? v.file : "");
  const id = useId();
  const next: Record<string, YamlValue> = {};
  if (level) next.level = level;
  if (file.trim()) next.file = file.trim();
  const empty = Object.keys(next).length === 0;
  const changed = !same(empty ? undefined : next, value);
  return (
    <>
      <div className="form-inline">
        <label className="form-inline-field">
          <span>Level</span>
          <select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">dekit's default</option>
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="form-inline-field" htmlFor={id}>
          <span>File</span>
          <input id={id} className="input mono" value={file} placeholder="dekit.log" onChange={(e) => setFile(e.target.value)} />
        </label>
      </div>
      <div className="settings-card-actions">
        <button type="button" className="btn btn-sm" disabled={!changed} onClick={() => onSave(empty ? { op: "unset", path: [], key: "log" } : { op: "set", path: [], key: "log", value: next })}>
          Review and save…
        </button>
      </div>
    </>
  );
}

function HookCard({ name, value, text, onSave }: { name: "on_init" | "on_idle"; value: YamlValue | undefined; text: string | undefined; onSave(op: EditOp): void }) {
  const v = value && typeof value === "object" && !Array.isArray(value) && !isJs(value) ? (value as Record<string, YamlValue>) : null;
  const simple = value === undefined || (v !== null && typeof v.command === "string" && HOOK_VERBS.includes(v.command as (typeof HOOK_VERBS)[number]) && Object.keys(v).every((k) => k === "command" || k === "target"));
  const [command, setCommand] = useState(simple && v ? String(v.command) : "");
  const [target, setTarget] = useState(simple && v && typeof v.target === "string" ? v.target : "");
  const [raw, setRaw] = useState(text ?? "");
  const id = useId();
  if (!simple) {
    return (
      <>
        <p className="field-hint">This hook uses more than one command or a full task spec: edit it as text.</p>
        <textarea className="input mono settings-text" rows={6} aria-label={`${name} as YAML`} value={raw} spellCheck={false} onChange={(e) => setRaw(e.target.value)} />
        <div className="settings-card-actions">
          <button type="button" className="btn btn-sm" disabled={raw === text} onClick={() => onSave({ op: "text", path: [name], text: raw })}>
            Review and save…
          </button>
        </div>
      </>
    );
  }
  const next: Record<string, YamlValue> | undefined = command ? (TARGET_VERBS.has(command) ? { command, target: target.trim() } : { command }) : undefined;
  const changed = !same(next, value);
  return (
    <>
      <div className="form-inline">
        <label className="form-inline-field">
          <span>Run</span>
          <select className="input" value={command} onChange={(e) => setCommand(e.target.value)}>
            <option value="">Nothing</option>
            {HOOK_VERBS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {TARGET_VERBS.has(command) && (
          <label className="form-inline-field" htmlFor={id}>
            <span>On</span>
            <input id={id} className="input mono" value={target} placeholder="+backend or web" onChange={(e) => setTarget(e.target.value)} />
          </label>
        )}
      </div>
      <div className="settings-card-actions">
        <button type="button" className="btn btn-sm" disabled={!changed || (TARGET_VERBS.has(command) && !target.trim())} onClick={() => onSave(next ? { op: "set", path: [], key: name, value: next } : { op: "unset", path: [], key: name })}>
          Review and save…
        </button>
      </div>
    </>
  );
}

function VarsCard({ text, onSave }: { text: string; onSave(op: EditOp): void }) {
  const [raw, setRaw] = useState(text);
  return (
    <>
      <p className="settings-warn">
        <Icon name="warning" size={13} /> <code>vars</code> are read by <code>!js</code> values, which only dekit can evaluate: Portplane checks the YAML, not what the scripts do with it.
      </p>
      <textarea className="input mono settings-text" rows={Math.min(14, Math.max(4, raw.split("\n").length + 1))} aria-label="vars as YAML" value={raw} spellCheck={false} onChange={(e) => setRaw(e.target.value)} />
      <div className="settings-card-actions">
        <button type="button" className="btn btn-sm" disabled={raw === text || !raw.trim().startsWith("vars:")} onClick={() => onSave({ op: "text", path: ["vars"], text: raw })}>
          Review and save…
        </button>
      </div>
    </>
  );
}

function LoadCard({ config, onSave }: { config: ProjectConfig; onSave(op: EditOp): void }) {
  const [file, setFile] = useState("");
  const [at, setAt] = useState("");
  return (
    <>
      {config.load.length ? (
        <ul className="load-list">
          {config.load.map((l) => (
            <li key={`${l.file}|${l.at ?? ""}`}>
              <Icon name="file" size={13} />
              <span className="mono">{l.file}</span>
              {l.at && <span className="tag">at {l.at}</span>}
              {l.file.includes(".portplane/") && <span className="tag">Portplane</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No fragments: every task is in dekit.yaml.</p>
      )}
      <div className="form-inline">
        <label className="form-inline-field">
          <span>File or glob</span>
          <input className="input mono" value={file} placeholder="services/*.yaml" onChange={(e) => setFile(e.target.value)} />
        </label>
        <label className="form-inline-field">
          <span>Mount at</span>
          <input className="input mono input-short" value={at} placeholder="(none)" onChange={(e) => setAt(e.target.value)} />
        </label>
        <button type="button" className="btn btn-sm" disabled={!file.trim()} onClick={() => onSave({ op: "load", file: file.trim(), at: at.trim() || undefined })}>
          Add fragment…
        </button>
      </div>
    </>
  );
}

export function SettingsPanel({ runner, config, os, onSaved }: { runner: string; config: ProjectConfig; os?: string; onSaved(): void }) {
  const { api } = useApp();
  const { help } = useDekitHelp();
  const [pending, setPending] = useState<{ title: string; ops: EditOp[] } | null>(null);
  const main = config.files[0];
  const save = (title: string) => (op: EditOp) => setPending({ title, ops: [op] });
  const fh = (key: string) => (fieldHelp(help, key) ? <FieldHelp help={help} fieldKey={key} /> : undefined);
  if (!main.editable) {
    return (
      <p className="form-readonly">
        <Icon name="info" size={15} /> {main.problem}. Use the YAML tab.
      </p>
    );
  }
  return (
    <div className="settings-panel">
      <Card title="Defaults for every task" help={fh("defaults")}>
        <TaskForm runner={runner} config={config} entry={null} defaults os={os} onSaved={onSaved} />
      </Card>
      <Card title="Which dekit runs this project" help={<>{fh("kernel")}</>}>
        <KernelCard key={JSON.stringify(config.settings.kernel ?? null)} value={config.settings.kernel} onSave={save("Pin the kernel")} />
      </Card>
      <Card title="Fragments" help={fh("load")}>
        <LoadCard config={config} onSave={save("Add a fragment")} />
      </Card>
      <Card title="When the project loads" help={fh("on_init")}>
        <HookCard key={`init${JSON.stringify(config.settings.on_init ?? null)}`} name="on_init" value={config.settings.on_init} text={config.text.on_init} onSave={save("on_init hook")} />
      </Card>
      <Card title="When everything goes idle" help={fh("on_idle")}>
        <HookCard key={`idle${JSON.stringify(config.settings.on_idle ?? null)}`} name="on_idle" value={config.settings.on_idle} text={config.text.on_idle} onSave={save("on_idle hook")} />
      </Card>
      <Card title="The runner's own log" help={fh("log")}>
        <LogCard key={JSON.stringify(config.settings.log ?? null)} value={config.settings.log} onSave={save("Runner log")} />
      </Card>
      <Card title="Variables for !js" help={<>{fh("vars")} <HelpLink tag="config/js">JavaScript values</HelpLink></>}>
        {config.text.vars !== undefined ? <VarsCard key={config.text.vars} text={config.text.vars} onSave={save("vars")} /> : <p className="muted">No vars. Add them in the YAML tab when a !js value needs one.</p>}
      </Card>
      {pending && (
        <SaveReview
          title={pending.title}
          runner={runner}
          folder={config.root === "host" ? config.file.replace(/\/[^/]+$/, "") : config.root}
          run={(write) => api.dekitEdit({ runner, file: main.path, digests: digestOf(config, main.path), ops: pending.ops, write })}
          onClose={() => setPending(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
