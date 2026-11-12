import { useEffect, useId, useRef, useState } from "react";
import { useJobs } from "../api/jobs";
import { Icon, Spinner } from "../components/Icon";
import { JobCard } from "../components/JobCard";
import { useShell } from "./ShellContext";

const RECENT = 6;

/** A spinner and a count while jobs run; a popover with the recent ones. */
export function JobsIndicator() {
  const { jobs, running } = useJobs();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { route } = useShell();

  // Going somewhere else closes it.
  useEffect(() => setOpen(false), [route]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (jobs.length === 0) return null;
  const count = running.length;
  const label = count > 0 ? `${count} ${count === 1 ? "job" : "jobs"} running` : "Recent jobs";

  return (
    <div
      className="jobs-wrap"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={`jobs-btn${count > 0 ? " is-running" : ""}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        {count > 0 ? <Spinner size={14} /> : <Icon name="jobs" size={16} />}
        {count > 0 && <span className="jobs-count">{count}</span>}
      </button>
      {open && (
        <section className="jobs-pop" id={id} aria-label="Recent jobs">
          <h2 className="jobs-pop-title">Jobs</h2>
          <div className="jobs-pop-list">
            {jobs.slice(0, RECENT).map((job) => (
              <JobCard key={job.id} job={job} lines={4} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
