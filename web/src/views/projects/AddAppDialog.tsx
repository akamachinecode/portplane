import { useId, useMemo, useState } from "react";
import type { EditResult, NewApp, ProjectConfig, ReadySuggestion, Suggestion } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useApp } from "../../components/AppContext";
import { Field } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Icon, Spinner } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { suggestAppName, suggestPath, validUrlName } from "../../lib/dekit/newApp";
import { relPath, taskLabel } from "../../lib/dekit/taskForm";
import { CommandField, TaskPicker, taskParent } from "./fields";
import { SaveReview } from "./SaveReview";
import { digestOf } from "./TasksPanel";

// "Add an app" by hand (plan §4.6), for anything the scanner doesn't
// know: Python, Go, Ruby, PHP, Docker. Four steps: folder, command, URL
// name, ready check and dependencies. It writes Portplane's fragment by
// default; "Write to dekit.yaml" is the other choice.

const STEPS = ["Folder", "Command", "URL", "Ready and needs"] as const;
const LANG: Record<Suggestion["lang"], string> = { node: "Node", python: "Python", go: "Go", ruby: "Ruby", php: "PHP", docker: "Docker", procfile: "Procfile" };

export function AddAppDialog({ runner, config, onClose, onAdded }: { runner: string; config: ProjectConfig; onClose(): void; onAdded(): void }) {
  const { api, info } = useApp();
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState(config.root === "host" ? "" : config.root);
  const [suggestions, setSuggestions] = useState<{ status: "idle" | "loading" | "ok" | "error"; list: Suggestion[]; error?: string; folder?: string }>({ status: "idle", list: [] });
  const [picked, setPicked] = useState<string | null>(null);
  const [cmd, setCmd] = useState<string[]>([""]);
  const [job, setJob] = useState(false);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [urlMode, setUrlMode] = useState<"wrap" | "alias" | "none">("wrap");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [ready, setReady] = useState<ReadySuggestion | null>(null);
  const [deps, setDeps] = useState<string[]>([]);
  const [target, setTarget] = useState<"portplane" | "main">("portplane");
  const [reviewing, setReviewing] = useState(false);
  const ids = { folder: useId(), path: useId(), label: useId(), name: useId(), port: useId(), ready: useId() };
  const tasks = useMemo(() => config.tasks.filter((t) => !t.folder), [config]);
  const taken = new Set(tasks.map((t) => t.path));
  const inside = !folder || config.root === "host" || folder === config.root || folder.startsWith(`${config.root}/`);

  const choose = (s: Suggestion) => {
    setPicked(s.id);
    setCmd(s.cmd);
    setJob(!!s.job);
    setReady(s.ready ?? null);
    setUrlMode(s.job ? "none" : s.wrap ? "wrap" : s.port ? "alias" : "none");
    if (s.port) setPort(String(s.port));
  };

  const loadSuggestions = () => {
    const f = folder.trim();
    setSuggestions({ status: "loading", list: [], folder: f });
    if (!path) setPath(suggestPath(f, config.root, taken));
    if (!name) setName(suggestAppName(f, config.root));
    api.dekitSuggest(f).then(
      (r) => {
        setSuggestions({ status: "ok", list: r.suggestions, folder: f });
        if (r.suggestions[0]) choose(r.suggestions[0]);
      },
      (err: unknown) => setSuggestions({ status: "error", list: [], error: errorText(err), folder: f }),
    );
  };

  const urlError = urlMode === "none" ? null : validUrlName(name);
  const portError = urlMode === "alias" && !/^\d{2,5}$/.test(port.trim()) ? "Enter the port the app listens on." : null;
  const pathError = !path.trim() ? "Enter a name for the task." : /[\s*?[\]{}:]/.test(path) ? "No spaces or wildcards." : taken.has(path.trim()) ? `${path.trim()} already exists.` : null;
  const canNext = [inside && !!folder.trim(), cmd[0]?.trim() && !pathError, urlMode === "none" || (!urlError && !portError), true][step];

  const app: NewApp = {
    path: path.trim(),
    label: label.trim() || undefined,
    folder: folder.trim(),
    cmd: cmd.filter((w, i) => w || i === 0),
    job: job || undefined,
    name: urlMode === "none" || job ? undefined : name.trim(),
    wrap: urlMode === "wrap" || undefined,
    port: urlMode === "alias" ? Number(port) : undefined,
    ready: job ? undefined : (ready ?? undefined),
    deps: deps.length ? deps : undefined,
  };
  const relFolder = config.root === "host" ? folder : relPath(config.root, folder) || ".";

  const pick = async () => {
    const res = await api.pickFolder();
    if (res.kind === "picked") setFolder(res.path);
  };

  const body = [
    <div key="folder" className="wizard-step">
      <p className="dialog-text">Where the app lives, inside this project.</p>
      <Field label="Folder" htmlFor={ids.folder} error={!inside ? `Choose a folder inside ${config.root}.` : null}>
        <div className="input-row">
          <input id={ids.folder} className="input mono" value={folder} spellCheck={false} onChange={(e) => setFolder(e.target.value)} data-autofocus />
          {info?.picker && (
            <button type="button" className="btn" onClick={() => void pick()}>
              <Icon name="folder" size={14} />
              Choose…
            </button>
          )}
        </div>
      </Field>
    </div>,
    <div key="cmd" className="wizard-step">
      {suggestions.status === "loading" && (
        <p className="muted">
          <Spinner size={12} /> Looking at <span className="mono">{relFolder}</span>…
        </p>
      )}
      {suggestions.status === "error" && <p className="field-error">{suggestions.error}</p>}
      {suggestions.status === "ok" && (
        <>
          <p className="dialog-text">{suggestions.list.length ? "Choose one, or write your own below." : "Nothing Portplane recognises here: write the command below."}</p>
          {suggestions.list.length > 0 && (
            <ul className="suggestions" aria-label="Suggested commands">
              {suggestions.list.map((s) => (
                <li key={s.id}>
                  <label className={`suggestion${picked === s.id ? " is-picked" : ""}`}>
                    <input type="radio" name="suggestion" checked={picked === s.id} onChange={() => choose(s)} />
                    <span className="suggestion-text">
                      <span className="suggestion-label">
                        {s.label} <span className="tag">{LANG[s.lang]}</span>
                        {s.job && <span className="tag">step</span>}
                      </span>
                      <span className="mono suggestion-cmd">{s.cmd.join(" ")}</span>
                      <span className="muted suggestion-src">from {s.source}</span>
                      {s.note && <span className="suggestion-note">{s.note}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <Field label="Command">
        <CommandField value={cmd} onChange={(c) => (setCmd(c), setPicked(null))} label="Command" />
      </Field>
      <div className="form-inline">
        <label className="form-inline-field" htmlFor={ids.path}>
          <span>Task name</span>
          <input id={ids.path} className="input mono" value={path} aria-invalid={!!pathError || undefined} onChange={(e) => setPath(e.target.value)} />
        </label>
        <label className="form-inline-field" htmlFor={ids.label}>
          <span>Label</span>
          <input id={ids.label} className="input" value={label} placeholder={path.split("/").pop()} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="form-inline-field">
          <input type="checkbox" checked={job} onChange={(e) => setJob(e.target.checked)} />
          <span>Runs once (a step, like an install)</span>
        </label>
      </div>
      {pathError && path && <p className="field-error">{pathError}</p>}
    </div>,
    <div key="url" className="wizard-step">
      {job ? (
        <p className="dialog-text">A step that runs once has no URL.</p>
      ) : (
        <>
          <p className="dialog-text">
            Give it an address like <span className="mono">https://{name || "api"}.localhost</span>.
          </p>
          <Segmented<"wrap" | "alias" | "none">
            label="How it gets its URL"
            value={urlMode}
            onChange={setUrlMode}
            options={[
              { value: "wrap", label: "portless runs it" },
              { value: "alias", label: "It has a fixed port" },
              { value: "none", label: "No URL" },
            ]}
          />
          <p className="field-hint">
            {urlMode === "wrap"
              ? "portless picks a free port and passes it to the app in PORT."
              : urlMode === "alias"
                ? "For a server that can't take a port, such as php -S or docker compose."
                : "The app runs without a .localhost address."}
          </p>
          {urlMode !== "none" && (
            <div className="form-inline">
              <label className="form-inline-field" htmlFor={ids.name}>
                <span>Name</span>
                <span className="name-affix-row">
                  <span className="muted">https://</span>
                  <input id={ids.name} className="input mono" value={name} aria-invalid={!!urlError || undefined} onChange={(e) => setName(e.target.value.toLowerCase())} />
                  <span className="muted">.localhost</span>
                </span>
              </label>
              {urlMode === "alias" && (
                <label className="form-inline-field" htmlFor={ids.port}>
                  <span>Port</span>
                  <input id={ids.port} className="input mono input-short" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
                </label>
              )}
            </div>
          )}
          {(urlError || portError) && urlMode !== "none" && <p className="field-error">{urlError ?? portError}</p>}
        </>
      )}
    </div>,
    <div key="ready" className="wizard-step">
      {!job && (
        <Field label="Ready when" htmlFor={ids.ready} hint="Apps that need it wait for this.">
          <select
            id={ids.ready}
            className="input"
            value={ready?.log !== undefined ? "log" : ready?.tcp !== undefined ? "tcp" : ready?.http !== undefined ? "http" : "none"}
            onChange={(e) => {
              const v = e.target.value;
              setReady(v === "log" ? { log: ready?.log ?? "ready" } : v === "tcp" ? { tcp: Number(port) || 3000 } : v === "http" ? { http: "http://127.0.0.1:3000" } : null);
            }}
          >
            <option value="none">As soon as it starts</option>
            <option value="log">A line of output</option>
            <option value="tcp">A port answers</option>
            <option value="http">A URL answers</option>
          </select>
          {ready?.log !== undefined && <input className="input mono form-gap" aria-label="Text to wait for" value={ready.log} onChange={(e) => setReady({ log: e.target.value })} />}
          {ready?.tcp !== undefined && <input className="input mono form-gap input-short" aria-label="Port" value={String(ready.tcp)} onChange={(e) => setReady({ tcp: Number(e.target.value) || 0 })} />}
          {ready?.http !== undefined && <input className="input mono form-gap" aria-label="URL" value={ready.http} onChange={(e) => setReady({ http: e.target.value })} />}
        </Field>
      )}
      <Field label="Needs" hint="Tasks to finish first, such as an install step.">
        <TaskPicker value={deps} onChange={setDeps} options={tasks.map((t) => ({ path: t.path, label: taskLabel(t.path, t.values) }))} label="Tasks it needs" near={taskParent(path.trim())} />
      </Field>
      {config.root !== "host" && (
        <fieldset className="radio-list">
          <legend className="field-label">Write it to</legend>
          <label className="radio-item">
            <input type="radio" name="target" checked={target === "portplane"} onChange={() => setTarget("portplane")} />
            <span>
              <span className="radio-label">Portplane's tasks (.portplane/tasks.yaml)</span>
              <span className="radio-hint">Keeps your dekit.yaml as you wrote it.</span>
            </span>
          </label>
          <label className="radio-item">
            <input type="radio" name="target" checked={target === "main"} onChange={() => setTarget("main")} />
            <span>
              <span className="radio-label">dekit.yaml</span>
              <span className="radio-hint">Next to the tasks you wrote.</span>
            </span>
          </label>
        </fieldset>
      )}
    </div>,
  ];

  const digests = target === "main" ? digestOf(config, config.file) : { ...digestOf(config, config.file), ...digestOf(config, config.fragment) };

  return (
    <>
      <Dialog
        open={!reviewing}
        onClose={onClose}
        title="Add an app"
        size="md"
        head={
          <nav className="steps" aria-label="Steps">
            <ol>
              {STEPS.map((s, i) => (
                <li key={s}>
                  <span className="step" aria-current={i === step ? "step" : undefined}>
                    <span className="step-num">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
                    {s}
                  </span>
                </li>
              ))}
            </ol>
          </nav>
        }
        footer={
          <>
            {step > 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => setStep(step - 1)}>
                Back
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canNext}
                onClick={() => {
                  if (step === 0 && suggestions.folder !== folder.trim()) loadSuggestions();
                  setStep(step + 1);
                }}
              >
                Next
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => setReviewing(true)}>
                Review…
              </button>
            )}
          </>
        }
      >
        {body[step]}
      </Dialog>
      {reviewing && (
        <SaveReview
          title={`Add ${app.path}`}
          runner={runner}
          folder={config.root}
          run={(write): Promise<EditResult> => api.dekitAddApp({ runner, app, target, digests, write })}
          onClose={() => (setReviewing(false), onClose())}
          onSaved={onAdded}
        />
      )}
    </>
  );
}
