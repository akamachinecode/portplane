import { useEffect, useId, useState, type ReactNode } from "react";
import { errorText } from "../../api/errors";
import { useJob } from "../../api/jobs";
import type { Plan, PlanStep, PortlessAction, ProxyOptions } from "../../api/portless";
import { useApp } from "../../components/AppContext";
import { CommandLine } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Icon, Spinner } from "../../components/Icon";
import { JobCard } from "../../components/JobCard";
import { useMachineScope } from "../../components/MachineScope";
import { ErrorState, LoadingState } from "../../components/States";
import { sshCommand } from "../../lib/machineScope";
import { useMachineResources } from "./store";

/** Actions that remove or kill something get a red button. */
const DESTRUCTIVE: PortlessAction[] = ["uninstall", "prune-force", "ca-regenerate", "service-uninstall", "hosts-clean", "proxy-stop"];

const METHOD: Record<string, string> = {
  pkexec: "your system's password dialog",
  osascript: "the macOS password dialog",
  uac: "the Windows administrator prompt (UAC)",
};

function StepView({ step, index, many }: { step: PlanStep; index: number; many: boolean }) {
  const [args, setArgs] = useState(false);
  return (
    <li className="plan-step">
      <p className="plan-step-head">
        {many && <span className="plan-step-num">{index + 1}</span>}
        <span className="plan-step-label">{step.label}</span>
        {step.admin && (
          <span className="tag job-admin" title="Asks for your administrator password">
            <Icon name="shield" size={11} />
            admin
          </span>
        )}
      </p>
      {step.when && <p className="plan-when">{step.when}</p>}
      {step.terminal ? (
        <>
          <code className="plan-cmd">{step.terminal}</code>
          {step.argv && (
            <button type="button" className="link-btn plan-args-toggle" aria-expanded={args} onClick={() => setArgs((v) => !v)}>
              {args ? "Hide" : "Show"} the arguments{step.env ? " and environment" : ""}
            </button>
          )}
          {args && step.argv && (
            <div className="plan-args">
              <ol className="plan-argv" aria-label="Arguments, one per line">
                {step.argv.map((a, i) => (
                  <li key={i}>
                    <code>{a === "" ? "''" : a}</code>
                  </li>
                ))}
              </ol>
              {step.env && (
                <dl className="plan-env" aria-label="Environment">
                  {Object.entries(step.env).map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="plan-when">Portplane does this itself.</p>
      )}
    </li>
  );
}

/**
 * Shows exactly what an action runs (ADR-0020) and runs it as a job on a
 * click. Admin steps go through the system's password dialog; where no
 * dialog can open, the commands are there to copy.
 */
export function PlanDialog({
  action,
  options,
  onClose,
  onDone,
  children,
}: {
  action: PortlessAction;
  options?: ProxyOptions;
  onClose(): void;
  onDone?(ok: boolean): void;
  /** More to read before running, such as what prune will stop. */
  children?: ReactNode;
}) {
  const { api, toast } = useApp();
  const scope = useMachineScope();
  const resources = useMachineResources();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const job = useJob(jobId);
  const descId = useId();

  // The plan is built from the choices as they were when the dialog opened.
  const [choices] = useState(options);
  const load = () => {
    setError(null);
    setPlan(null);
    api.portlessPlan(action, choices).then(setPlan, (err: unknown) => setError(errorText(err)));
  };
  useEffect(load, [api, action, choices]);

  const ended = job && job.state !== "running";
  useEffect(() => {
    if (!job || job.state === "running") return;
    if (job.state === "succeeded") toast.info(`${job.title}: done`);
    onDone?.(job.state === "succeeded");
  }, [job?.state]);

  const start = async () => {
    setStarting(true);
    try {
      const j = await api.portlessRun(action, choices);
      setJobId(j.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const noDialog = !!plan?.admin && !plan.method;
  const local = plan?.steps.filter((s) => s.terminal).map((s) => s.terminal!) ?? [];
  // On a machine over SSH (ADR-0026) the commands run there, from a
  // terminal on this computer; nobody there can answer a password dialog.
  const name = scope.ms?.machine.name ?? scope.id;
  const terminal = scope.remote ? local.map((t) => sshCommand(scope.host, t)) : local;
  const danger = DESTRUCTIVE.includes(action);
  const [checking, setChecking] = useState(false);
  const checkAgain = async () => {
    setChecking(true);
    await Promise.all([
      resources.status.load(api),
      resources.routes.get().status !== "idle" ? resources.routes.load(api) : null,
      resources.doctor.get().status !== "idle" ? resources.doctor.load(api) : null,
    ]);
    setChecking(false);
    toast.info(`Checked ${name} again`);
    onDone?.(true);
    onClose();
  };

  const footer = (
    <>
      <span className="spacer" />
      {jobId ? (
        <button type="button" className="btn" onClick={onClose}>
          {ended ? "Close" : "Hide"}
        </button>
      ) : (
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {plan && noDialog && scope.remote && (
            <button type="button" className="btn btn-primary" onClick={() => void checkAgain()} disabled={checking} aria-busy={checking || undefined} aria-describedby={descId}>
              {checking && <Spinner />}
              Check again
            </button>
          )}
          {plan && !(noDialog && scope.remote) && (
            <button
              type="button"
              className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
              onClick={() => void start()}
              disabled={starting || noDialog}
              aria-busy={starting || undefined}
              aria-describedby={descId}
            >
              {starting ? <Spinner /> : plan.admin && <Icon name="shield" size={14} />}
              {plan.title}
            </button>
          )}
        </>
      )}
    </>
  );

  return (
    <Dialog open onClose={onClose} title={plan?.title ?? "Review"} size="md" footer={footer}>
      {error && !plan && <ErrorState title="Couldn't prepare this" message={error} onRetry={load} />}
      {!error && !plan && <LoadingState label="Working out what to run…" />}
      {plan && !jobId && (
        <div className="plan">
          <p className="plan-summary">{plan.summary}</p>
          {children}
          {plan.notes && plan.notes.length > 0 && (
            <ul className="plan-notes">
              {plan.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <h3 className="plan-title">{plan.steps.length === 1 ? "What runs" : "What runs, in order"}</h3>
          <ol className="plan-steps">
            {plan.steps.map((s, i) => (
              <StepView key={`${i}-${s.label}`} step={s} index={i} many={plan.steps.length > 1} />
            ))}
          </ol>
          <p className="plan-password" id={descId}>
            {plan.admin
              ? noDialog
                ? scope.remote
                  ? `Nobody at ${name}'s screen can answer a password dialog. Run these in a terminal here: each one opens SSH to ${name}, where sudo asks for your password. Then check again.`
                  : "This computer can't show a password dialog here. Run the commands above in a terminal instead:"
                : `Portplane asks for your password with ${METHOD[plan.method] ?? "your system's own dialog"}. It never sees your password.`
              : "This doesn't need your password."}
          </p>
          {noDialog && terminal.map((t) => <CommandLine key={t} command={t} />)}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      {job && (
        <div className="plan-job">
          <JobCard job={job} lines={10} />
          {job.state === "failed" && terminal.length > 0 && plan?.admin && (
            <details className="plan-fallback">
              <summary>Run it in a terminal instead</summary>
              {terminal.map((t) => (
                <CommandLine key={t} command={t} />
              ))}
            </details>
          )}
        </div>
      )}
    </Dialog>
  );
}
