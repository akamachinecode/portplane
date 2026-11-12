import { useId, useState } from "react";
import { errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";
import { CommandLine, Field } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Spinner } from "../../components/Icon";
import { joinCommand } from "../../lib/dekit/shell";
import { HelpLink } from "../runners/DekitHelp";
import { ArgvEditor, Chips, KeyValueEditor, TaskPicker } from "./fields";
import type { EnvRow } from "../../lib/dekit/taskForm";

// "Run a command…" (plan §4.7): dekit spawn. The task runs once in the
// project's runner without touching dekit.yaml, shows in the list with its
// output, and goes away with Remove. For migrations and one-off scripts.

export function RunCommandDialog({ runner, tasks, initialCwd, onClose, onStarted }: { runner: string; tasks: Array<{ path: string; label: string }>; initialCwd?: string; onClose(): void; onStarted(path: string): void }) {
  const { api, toast } = useApp();
  const [cmd, setCmd] = useState<string[]>([""]);
  const [path, setPath] = useState("tmp/run-1");
  const [cwd, setCwd] = useState(initialCwd ?? "");
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [deps, setDeps] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { path: useId(), cwd: useId() };
  const taken = new Set(tasks.map((t) => t.path));
  const pathError = !path.trim() ? "Enter a task path." : /[\s*?[\]{}:]/.test(path) || path.startsWith("/") ? "A task path has no spaces or wildcards." : taken.has(path.trim()) ? `${path.trim()} already exists.` : null;
  const words = cmd.filter((w, i) => w || i === 0);
  const ready = !!words[0]?.trim() && !pathError;
  const preview = [
    "dekit spawn",
    path.trim(),
    ...(cwd.trim() ? ["--cwd", cwd.trim()] : []),
    ...env.filter((r) => r.key.trim() && r.value !== null).flatMap((r) => ["--env", `${r.key.trim()}=${r.value}`]),
    ...deps.flatMap((d) => ["--dep", d]),
    ...tags.flatMap((t) => ["--tag", t]),
    "--",
    ...words,
  ];
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.dekitSpawn(runner, {
        path: path.trim(),
        cmd: words,
        cwd: cwd.trim() || undefined,
        env: Object.fromEntries(env.filter((r) => r.key.trim() && r.value !== null).map((r) => [r.key.trim(), r.value as string])),
        deps: deps.length ? deps : undefined,
        tags: tags.length ? tags : undefined,
      });
      toast.info(`Started ${path.trim()}`);
      onStarted(path.trim());
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Run a command"
      size="md"
      dismissable={!busy}
      footer={
        <>
          <HelpLink tag="cli/spawn" />
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready || busy} aria-busy={busy || undefined} onClick={() => void run()}>
            {busy && <Spinner />}
            Run
          </button>
        </>
      }
    >
      <p className="dialog-text">Runs once in this project's runner, without changing dekit.yaml. It shows in Apps with its output until you remove it.</p>
      <Field label="Command">
        <ArgvEditor value={cmd} onChange={setCmd} label="Command" placeholder="pnpm" />
      </Field>
      <div className="form-inline">
        <label className="form-inline-field" htmlFor={ids.path}>
          <span>Task path</span>
          <input id={ids.path} className="input mono" value={path} aria-invalid={!!pathError || undefined} onChange={(e) => setPath(e.target.value)} />
        </label>
        <label className="form-inline-field" htmlFor={ids.cwd}>
          <span>Folder</span>
          <input id={ids.cwd} className="input mono" value={cwd} placeholder="the project folder" onChange={(e) => setCwd(e.target.value)} />
        </label>
      </div>
      {pathError && <p className="field-error">{pathError}</p>}
      <details className="more-options">
        <summary>Environment, dependencies and tags</summary>
        <Field label="Environment">
          <KeyValueEditor value={env} onChange={setEnv} label="Environment" />
        </Field>
        <Field label="Start after">
          <TaskPicker value={deps} onChange={setDeps} options={tasks} label="Tasks to wait for" />
        </Field>
        <Field label="Tags">
          <Chips value={tags} onChange={setTags} label="Tags" />
        </Field>
      </details>
      {words[0] && <CommandLine command={`${preview.slice(0, -words.length).join(" ")} ${joinCommand(words)}`} />}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
