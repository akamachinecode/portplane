import { useEffect, useId, useState } from "react";
import { errorText } from "../../api/errors";
import { useJob } from "../../api/jobs";
import type { ComposeOverview, ComposePlan, ComposeProject, ComposeRequest } from "../../api/sharing";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { CommandLine, Field } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Icon, Spinner } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { JobCard } from "../../components/JobCard";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { inferHome, shortenPath } from "../../lib/format";
import { COMPOSE_STATE_LABELS, composeFileFrom, composeSummary } from "../../lib/sharing";
import { useShell } from "../../shell/ShellContext";
import { StatusGate } from "./ProxySection";
import { RenameDialog } from "./RenameDialog";
import { Requirements } from "./Requirements";
import { useIntent, useRefreshOnJobs } from "./store";
import "./Sharing.css";

/**
 * Start or stop a compose project (`portless compose up -d` / `down`):
 * what runs and where first, then the job with Docker's output. Without a
 * known compose file, it asks for one.
 */
function ComposeDialog({ request, needFile, onClose }: { request: ComposeRequest; needFile: boolean; onClose(): void }) {
  const { api, toast } = useApp();
  const [file, setFile] = useState(request.file ?? "");
  const [chosen, setChosen] = useState<string | null>(needFile ? null : (request.file ?? ""));
  const [plan, setPlan] = useState<ComposePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const fileId = useId();

  useEffect(() => {
    if (chosen === null) return;
    setError(null);
    setPlan(null);
    api.portlessComposePreview({ ...request, file: chosen || undefined }).then(setPlan, (err: unknown) => setError(errorText(err)));
  }, [api, chosen]);
  useEffect(() => {
    if (job?.state === "succeeded") toast.info(`${job.title}: done`);
  }, [job?.state]);

  const run = async () => {
    if (!plan) return;
    setStarting(true);
    try {
      const j = await api.portlessComposeRun({ ...request, file: chosen || undefined });
      setJobId(j.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const asking = chosen === null || (!!plan?.problem && request.op === "up" && !plan.file);
  const title = request.op === "up" ? (request.project ? `Start ${request.project}` : "Start a compose project") : `Stop ${request.project}`;
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
      {asking ? (
        <button type="submit" form={fileId + "-form"} className="btn btn-primary" disabled={!file.trim()}>
          Continue
        </button>
      ) : (
        plan &&
        !plan.problem && (
          <button type="button" className={`btn ${request.op === "down" ? "btn-danger" : "btn-primary"}`} onClick={() => void run()} disabled={starting} aria-busy={starting || undefined}>
            {starting ? <Spinner /> : <Icon name={request.op === "up" ? "play" : "stop"} size={13} />}
            {plan.title}
          </button>
        )
      )}
    </>
  );

  return (
    <Dialog open onClose={onClose} title={plan?.title ?? title} size="md" footer={footer}>
      {!jobId && asking && (
        <form
          id={fileId + "-form"}
          className="compose-file-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (file.trim()) setChosen(file.trim());
          }}
        >
          <p className="plan-summary">
            {request.project
              ? `Portplane doesn't know where ${request.project}'s compose file is. Give its full path, or the folder that holds it.`
              : "Give the full path of a compose file, or the folder that holds compose.yaml. portless starts the project in the background and gives each web service an address."}
          </p>
          <Field label="Compose file" htmlFor={fileId} error={chosen !== null ? (plan?.problem ?? error) : null} hint="Such as /home/dev/code/shop/compose.yaml">
            <input id={fileId} className="input mono" value={file} spellCheck={false} autoComplete="off" data-autofocus onChange={(e) => setFile(e.target.value)} placeholder="/home/dev/code/shop/compose.yaml" />
          </Field>
        </form>
      )}
      {!jobId && !asking && (
        <>
          {error && !plan && <ErrorState title="Couldn't prepare this" message={error} />}
          {!error && !plan && <LoadingState label="Working out what to run…" />}
          {plan && (
            <div className="plan">
              <p className="plan-summary">{plan.summary}</p>
              {plan.problem && (
                <p className="field-error" role="alert">
                  {plan.problem}
                </p>
              )}
              {plan.warnings.map((w) => (
                <p key={w} className="rename-note rename-warn">
                  <Icon name="warning" size={13} />
                  {w}
                </p>
              ))}
              <h3 className="plan-title">What runs</h3>
              <CommandLine command={plan.terminal} />
              <p className="plan-password">This doesn't need your password. The job shows Docker's output as it comes.</p>
              {error && (
                <p className="field-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {job && <JobCard job={job} lines={14} />}
    </Dialog>
  );
}

function Project({ p, tld }: { p: ComposeProject; tld: string }) {
  const ctx = useApp();
  const { snapshot } = useShell();
  const machine = snapshot?.machines.find((m) => m.machine.local)?.machine.id ?? "local";
  const [op, setOp] = useState<ComposeRequest | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const routeFor = (service: string) => p.routes.find((r) => r.service === service);
  const dot = p.state === "running" ? "on" : p.state === "stopped" ? "off" : "off";
  return (
    <section className="compose-project" aria-labelledby={`compose-${p.name}`}>
      <header className="compose-head">
        <div className="compose-title-block">
          <h3 className="compose-title" id={`compose-${p.name}`}>
            {p.name}
          </h3>
          <p className="compose-meta">
            <span className="inline-state">
              <StateDot state={dot} />
              {COMPOSE_STATE_LABELS[p.state]}
            </span>
            <span className="muted"> · {composeSummary(p)}</span>
            <span className="muted mono"> · *.{p.label}.{tld}</span>
          </p>
        </div>
        <span className="spacer" />
        {p.state === "running" ? (
          <button type="button" className="btn btn-sm" onClick={() => setOp({ op: "down", project: p.name, file: p.file })}>
            <Icon name="stop" size={12} />
            Stop…
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={() => setOp({ op: "up", project: p.name, file: p.file })}>
            <Icon name="play" size={12} />
            Start…
          </button>
        )}
        {p.state === "stopped" && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOp({ op: "down", project: p.name, file: p.file })}>
            Bring down…
          </button>
        )}
      </header>
      <p className="compose-file">
        {p.file ? (
          <span className="mono path-value" title={`${p.file}\nFound from ${composeFileFrom(p)}`}>
            {shortenPath(p.file, inferHome([p.file]))}
          </span>
        ) : (
          <span className="muted">Portplane hasn't found this project's compose file; Start asks for it.</span>
        )}
      </p>
      {p.state === "down" && <p className="fact-note">Brought down: portless keeps nothing about it, so Portplane remembers its file.</p>}
      {p.services.length > 0 && (
        <div className="table-wrap">
          <table className="table compose-table">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Address</th>
                <th scope="col" className="num">
                  Ports
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {p.services.map((s) => {
                const route = routeFor(s.name);
                const routed = s.ports.filter((x) => x.routed);
                const kept = s.ports.filter((x) => !x.routed);
                return (
                  <tr key={s.name}>
                    <td>
                      <span className="mono">{s.name}</span>
                      {s.nameLabel && <span className="muted"> · portless.name {s.nameLabel}</span>}
                      {s.image && <span className="muted compose-image"> {s.image}</span>}
                    </td>
                    <td>
                      {route ? (
                        <span className="share-url-cell">
                          {route.listening ? (
                            <a className="addr" href={route.url} target="_blank" rel="noopener noreferrer">
                              {route.hostname}
                            </a>
                          ) : (
                            <span className="addr addr-idle">{route.hostname}</span>
                          )}
                          <IconButton icon="copy" label={`Copy ${route.url}`} onClick={() => void copyWithToast(ctx, route.url, "the URL")} />
                        </span>
                      ) : routed.length ? (
                        <span className="muted">Gets an address when the project starts</span>
                      ) : (
                        <span className="muted">{s.ports.length ? "No web port" : "No published ports"}</span>
                      )}
                    </td>
                    <td className="num mono compose-ports">
                      {routed.map((x) => (
                        <span key={x.target} title={x.hostPort ? `127.0.0.1:${x.hostPort} → container port ${x.target}` : `container port ${x.target}`}>
                          {x.target}
                          {x.hostPort ? `→${x.hostPort}` : ""}
                        </span>
                      ))}
                      {kept.map((x) => (
                        <span key={x.target} className="muted" title={`Keeps its own port: ${x.reason ?? ""}`}>
                          {x.target} ({x.reason})
                        </span>
                      ))}
                    </td>
                    <td className="row-actions-cell">
                      {route ? <IconButton icon="pencil" label={`Change the name of ${s.name}`} onClick={() => setRename(route.hostname)} /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {op && <ComposeDialog request={op} needFile={op.op === "up" && !p.file} onClose={() => setOp(null)} />}
      {rename && <RenameDialog machine={machine} appId="" route={rename} label={p.services.find((s) => routeFor(s.name)?.hostname === rename)?.name ?? rename} onClose={() => setRename(null)} />}
    </section>
  );
}

/** Docker Compose projects portless runs, their services and addresses (plan §5.9). */
export function ComposeSection() {
  const { api } = useApp();
  const [ov, setOv] = useState<ComposeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useIntent("compose-start", () => setAdding(true));
  const load = () => {
    setError(null);
    api.portlessCompose().then(setOv, (err: unknown) => setError(errorText(err)));
  };
  useEffect(load, [api]);
  useRefreshOnJobs(load);

  return (
    <StatusGate>
      {() => {
        if (!ov) return error ? <ErrorState title="Couldn't read the compose projects" message={error} onRetry={load} /> : <LoadingState label="Reading compose projects…" />;
        const missing = ov.requirements.filter((r) => !r.ok);
        return (
          <>
            <div className="section-bar">
              <p className="section-bar-text">
                {ov.projects.length} {ov.projects.length === 1 ? "project" : "projects"}
              </p>
              <span className="spacer" />
              <button type="button" className="btn btn-sm" onClick={load}>
                <Icon name="restart" size={13} />
                Refresh
              </button>
              {/* neutral: Addresses' one green button is New alias */}
              <button type="button" className="btn btn-sm" disabled={!ov.docker} onClick={() => setAdding(true)}>
                <Icon name="plus" size={13} />
                Start a compose project…
              </button>
            </div>
            {missing.length > 0 && (
              <div className="compose-reqs">
                <Requirements reqs={ov.requirements} onChanged={load} />
              </div>
            )}
            {ov.projects.length === 0 ? (
              <EmptyState icon="box" title="No compose projects yet">
                Run <code>portless compose up</code> in a project's folder, or start one here: every service that publishes a web port gets an address like <span className="mono">web.shop.{ov.tld}</span>.
              </EmptyState>
            ) : (
              <div className="compose-list">
                {ov.projects.map((p) => (
                  <Project key={p.name} p={p} tld={ov.tld} />
                ))}
              </div>
            )}
            {adding && <ComposeDialog request={{ op: "up" }} needFile onClose={() => setAdding(false)} />}
          </>
        );
      }}
    </StatusGate>
  );
}
