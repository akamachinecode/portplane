import { useEffect, useId, useRef, useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import { useJob } from "../../api/jobs";
import type { NameInfo, NamePreview } from "../../api/portless";
import { useApp } from "../../components/AppContext";
import { CommandLine } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { FileDiff } from "../../components/FileDiff";
import { Icon, Spinner } from "../../components/Icon";
import { JobCard } from "../../components/JobCard";
import { ErrorState, LoadingState } from "../../components/States";
import { previewHostname, renameProblem, SOURCE_LABELS } from "../../lib/portless";
import { TYPING_DELAY } from "../../lib/setup";
// Its styles live with the Domains view, which may not have loaded (the app detail opens this too).
import "../DomainsView.css";

function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

/** Where the name lives, and what Portplane does with it, in a sentence. */
function sourceText(info: NameInfo): string {
  switch (info.source) {
    case "fragment":
      return "The name is in the task Portplane wrote for this app. Portplane changes it there, reloads dekit and restarts the app.";
    case "task":
      return "The name is in the task's command in your dekit file. Portplane changes only that value and shows you the change first.";
    case "config":
      return info.inferred
        ? `portless works this name out from the folder (package.json or the folder's name). Portplane writes the new one in ${info.target ?? "portless.json"}.`
        : `The name is in the project's ${info.target ?? "portless.json"}. Portplane changes it there and restarts the app.`;
    case "alias-task":
      return `The name comes from an alias job (${info.task}). Portplane changes its command, removes the old alias and runs the job again.`;
    case "alias":
      return "The name is a portless alias. Portplane adds the new one and removes the old one.";
    case "compose":
      return info.editable
        ? `The name is the portless.name label of the ${info.service ?? "service"} service in the project's compose file. Portplane sets that label${info.running ? ", then starts the project again so the new address takes over" : ""}.`
        : "The name comes from a docker compose label.";
    default:
      return "";
  }
}

/**
 * Changes an app's portless name (plan §5.4): checks the name as you type,
 * previews the final URL and the exact file change, then applies it as a
 * job (write, reload dekit, restart). A compose service has no app: it is
 * named by its address (route) instead, and its name is the portless.name
 * label in the compose file.
 */
export function RenameDialog({ machine, appId, route, label, runner, onClose }: { machine: string; appId: string; route?: string; label: string; runner?: string; onClose(): void }) {
  const { api, toast } = useApp();
  const [info, setInfo] = useState<NameInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<NamePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const inputId = useId();
  const hintId = useId();
  const seq = useRef(0);
  const [nonce, setNonce] = useState(0); // a new preview after a refused apply

  const load = () => {
    setLoadError(null);
    api.portlessNameInfo(machine, appId, route).then(
      (i) => {
        setInfo(i);
        setName(i.name);
      },
      (err: unknown) => setLoadError(errorText(err)),
    );
  };
  useEffect(load, [api, machine, appId, route]);

  const local = info ? renameProblem(info, name) : null;
  // The server's preview, a moment after typing stops.
  useEffect(() => {
    if (!info?.editable || local) {
      setPreview(null);
      return;
    }
    const n = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => {
      api.portlessNamePreview(machine, appId, name, route).then(
        (p) => {
          if (n !== seq.current) return;
          setPreview(p);
          setChecking(false);
        },
        (err: unknown) => {
          if (n !== seq.current) return;
          setPreview({ name, files: [], steps: [], warnings: [], problem: errorText(err) });
          setChecking(false);
        },
      );
    }, TYPING_DELAY);
    return () => clearTimeout(t);
  }, [api, machine, appId, route, name, info, local, nonce]);

  useEffect(() => {
    if (job?.state === "succeeded") toast.info(`${label} is now at ${preview?.hostname ?? "its new address"}`);
  }, [job?.state]);

  const apply = async () => {
    if (!preview?.digest) return;
    setStarting(true);
    setApplyError(null);
    try {
      const j = await api.portlessRename(machine, appId, name, preview.digest, route);
      setJobId(j.id);
    } catch (err) {
      setApplyError(err instanceof ApiError && err.status === 409 ? "The file changed since this preview. Check the new preview below, then rename again." : errorText(err));
      if (err instanceof ApiError && err.status === 409) setNonce((n) => n + 1);
      setPreview(null);
    } finally {
      setStarting(false);
    }
  };

  const unchanged = !!info && name.trim().toLowerCase() === info.name && !info.inferred;
  const problem = unchanged ? null : (local ?? preview?.problem ?? null);
  const ready = !!preview && !preview.problem && !local && !checking && !!preview.digest;
  const host = info ? (preview?.hostname ?? previewHostname(info, name)) : "";
  const prefix = info?.runMode && info.prefix ? `${info.prefix}.` : "";

  const footer = jobId ? (
    <>
      <span className="spacer" />
      <button type="button" className="btn" onClick={onClose}>
        {job && job.state !== "running" ? "Close" : "Hide"}
      </button>
    </>
  ) : (
    <>
      <span className="spacer" />
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
      {info?.editable && (
        <button type="button" className="btn btn-primary" disabled={!ready || starting} aria-busy={starting || undefined} onClick={() => void apply()}>
          {starting && <Spinner />}
          Rename
        </button>
      )}
    </>
  );

  return (
    <Dialog open onClose={onClose} title={`Change the name of ${label}`} size="md" footer={footer}>
      {loadError && <ErrorState title="Couldn't find where this name lives" message={loadError} onRetry={load} />}
      {!loadError && !info && <LoadingState label="Finding where the name lives…" />}
      {info && !jobId && (
        <div className="rename">
          <p className="rename-where">
            <span className="muted">Now </span>
            <span className="mono">{info.hostname || "no address"}</span>
            <span className="muted"> · from {SOURCE_LABELS[info.source]}</span>
          </p>
          {sourceText(info) && <p className="rename-explain">{sourceText(info)}</p>}

          {!info.editable && (
            <div className="rename-readonly">
              <p>{info.reason}</p>
              {info.source === "compose" && (
                <pre className="rename-snippet">{`services:\n  ${info.service ?? "<service>"}:\n    labels:\n      portless.name: ${info.name || "<name>"}`}</pre>
              )}
              {info.file && (
                <>
                  <CommandLine command={info.file} />
                  {runner && dirOf(info.file) === runner && (
                    <button type="button" className="btn btn-sm" onClick={() => void api.reveal(machine, runner).catch((err: unknown) => toast.error(errorText(err)))}>
                      <Icon name="folder" size={13} />
                      Show the file's folder
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {info.editable && (
            <>
              <div className="field">
                <label className="field-label" htmlFor={inputId}>
                  New name
                </label>
                <div className={`name-field${problem ? " has-error" : ""}`} onClick={() => document.getElementById(inputId)?.focus()}>
                  <span className="name-affix">https://{prefix}</span>
                  <input
                    id={inputId}
                    className="name-input mono"
                    value={name}
                    size={Math.max(4, name.length + 1)}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="off"
                    data-autofocus
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={hintId}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && ready) {
                        e.preventDefault();
                        void apply();
                      }
                    }}
                  />
                  <span className="name-affix">.{info.suffix ?? info.tld}</span>
                </div>
                <div className="name-under" id={hintId}>
                  {problem ? (
                    <p className="field-error" role="alert">
                      {problem}
                    </p>
                  ) : unchanged ? (
                    <p className="name-url">Type a new name.</p>
                  ) : (
                    <p className="name-url">
                      {checking ? (
                        <>
                          <Spinner size={11} /> Checking…
                        </>
                      ) : (
                        <>
                          Opens at <span className="mono">{preview?.url ?? `https://${host}`}</span>
                        </>
                      )}
                    </p>
                  )}
                  <p className="field-hint">
                    {info.source === "compose"
                      ? `Lowercase letters, digits and dashes. It goes in front of the project's name, ${info.compose ?? "the project"}.`
                      : "Lowercase letters, digits, dashes and dots. A dot makes a subdomain: api.shop."}
                  </p>
                </div>
              </div>
              {info.notes.map((n) => (
                <p key={n} className="rename-note">
                  <Icon name="info" size={13} />
                  {n}
                </p>
              ))}
              {preview?.warnings.map((w) => (
                <p key={w} className="rename-note rename-warn">
                  <Icon name="warning" size={13} />
                  {w}
                </p>
              ))}
              {applyError && (
                <p className="field-error" role="alert">
                  {applyError}
                </p>
              )}
              {ready && preview.files.length > 0 && (
                <div className="rename-diff">
                  <h3 className="plan-title">The change</h3>
                  {preview.files.map((f) => (
                    <FileDiff key={f.path} file={f} folder={runner ?? dirOf(f.path)} />
                  ))}
                </div>
              )}
              {ready && preview.steps.length > 0 && (
                <>
                  <h3 className="plan-title">What happens</h3>
                  <ol className="rename-steps">
                    {preview.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </>
              )}
            </>
          )}
        </div>
      )}
      {job && <JobCard job={job} lines={8} />}
    </Dialog>
  );
}
