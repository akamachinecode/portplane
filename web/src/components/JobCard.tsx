import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorText } from "../api/errors";
import { useJobs, type Job, type JobStepState } from "../api/jobs";
import { useNow } from "../hooks/useNow";
import { formatDuration } from "../lib/format";
import { useApp } from "./AppContext";
import { Icon, Spinner, type IconName } from "./Icon";
import "./JobCard.css";

const STATE_LABEL: Record<Job["state"], string> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STEP_ICON: Record<Exclude<JobStepState, "running">, IconName> = {
  pending: "circle",
  succeeded: "checkCircle",
  failed: "xCircle",
  skipped: "minus",
};

const STEP_LABEL: Record<JobStepState, string> = {
  pending: "waiting",
  running: "running",
  succeeded: "done",
  failed: "failed",
  skipped: "skipped",
};

function StateIcon({ state }: { state: Job["state"] | JobStepState }) {
  if (state === "running") return <Spinner size={14} />;
  if (state === "cancelled") return <Icon name="minus" size={15} />;
  return <Icon name={STEP_ICON[state]} size={15} />;
}

/**
 * One job: its steps, the last lines of its output, its error, and Cancel
 * while it runs. `lines` caps the output box (the full card shows more).
 */
export function JobCard({ job, lines = 8, headingLevel = 3 }: { job: Job; lines?: number; headingLevel?: 2 | 3 | 4 }) {
  const { toast } = useApp();
  const { cancel } = useJobs();
  const [cancelling, setCancelling] = useState(false);
  const running = job.state === "running";
  const now = useNow(running);
  const started = Date.parse(job.startedAt);
  const ended = job.endedAt ? Date.parse(job.endedAt) : now;
  const out = useRef<HTMLPreElement>(null);
  const pinned = useRef(true); // the output box follows new lines while scrolled to the end
  const H = `h${headingLevel}` as const;

  useEffect(() => {
    if (!running) setCancelling(false);
  }, [running]);

  const shown = job.output.slice(-Math.max(lines * 4, 40));
  useLayoutEffect(() => {
    const el = out.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, job.output[job.output.length - 1]]);

  const onCancel = async () => {
    setCancelling(true);
    try {
      await cancel(job.id);
    } catch (err) {
      setCancelling(false);
      toast.error(`Couldn't cancel: ${errorText(err)}`);
    }
  };

  return (
    <article className={`job job-${job.state}`} aria-labelledby={`job-${job.id}-title`}>
      <header className="job-head">
        <span className="job-state-icon">
          <StateIcon state={job.state} />
        </span>
        <H className="job-title" id={`job-${job.id}-title`}>
          {job.title}
        </H>
        {job.privileged && (
          <span className="tag job-admin" title="Asks for your administrator password">
            <Icon name="shield" size={11} />
            admin
          </span>
        )}
        <span className="job-meta">
          <span className="job-state-label">{STATE_LABEL[job.state]}</span>
          {Number.isFinite(started) && <span className="job-time">{formatDuration(ended - started)}</span>}
        </span>
        {running && (
          <button type="button" className="btn btn-sm btn-ghost job-cancel" onClick={onCancel} disabled={cancelling} aria-busy={cancelling || undefined}>
            {cancelling && <Spinner size={12} />}
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </header>
      {job.steps.length > 0 && (
        <ol className="job-steps">
          {job.steps.map((s, i) => (
            <li key={`${i}-${s.name}`} className={`job-step job-step-${s.state}`}>
              <span className="job-step-icon">
                <StateIcon state={s.state} />
              </span>
              <span className="job-step-name">{s.name}</span>
              <span className="sr-only">: {STEP_LABEL[s.state]}</span>
            </li>
          ))}
        </ol>
      )}
      {shown.length > 0 && (
        <pre
          ref={out}
          className="job-output"
          style={{ maxHeight: `calc(${lines} * 1.5em + 16px)` }}
          tabIndex={0}
          aria-label={`Output of ${job.title}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          }}
        >
          {shown.join("\n")}
        </pre>
      )}
      {job.error && (
        <p className="job-error" role={job.state === "failed" ? "alert" : undefined}>
          {job.error}
        </p>
      )}
    </article>
  );
}
