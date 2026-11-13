import { useState } from "react";
import type { DoctorReport, Finding, FixKind } from "../../api/portless";
import { Icon, Spinner, type IconName } from "../../components/Icon";
import { ErrorState, LoadingState } from "../../components/States";
import { useNow } from "../../hooks/useNow";
import { ShortPath } from "./Fold";
import { doctorSummary, FIX_LABELS, groupFindings, routeAge } from "../../lib/portless";
import { PlanDialog } from "./PlanDialog";
import { StatusGate } from "./ProxySection";
import { StaleList } from "./routeParts";
import { useIntent, usePortlessDoctor, valueOf } from "./store";

const STATUS_ICON: Record<Finding["status"], IconName> = { ok: "checkCircle", warn: "warning", fail: "xCircle", info: "info" };
const STATUS_LABEL: Record<Finding["status"], string> = { ok: "OK", warn: "Warning", fail: "Problem", info: "Note" };

function Report({ report, running, run, at }: { report: DoctorReport; running: boolean; run(): void; at?: number }) {
  const [fix, setFix] = useState<FixKind | null>(null);
  const now = useNow(!!at, 15_000);
  const groups = groupFindings(report.findings);
  return (
    <>
      <div className="section-bar">
        <p className="section-bar-text">
          <strong>{doctorSummary(report).replace(/\.$/, "")}</strong>
          {at && <span className="muted"> · checked {routeAge(at, now) ?? "just now"} ago</span>}
        </p>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={run} disabled={running} aria-busy={running || undefined}>
          {running ? <Spinner size={12} /> : <Icon name="restart" size={13} />}
          {running ? "Checking…" : "Run again"}
        </button>
      </div>
      {report.parsed ? (
        <ul className="checks">
          {groups.map((g) => (
            <li key={g.check} className={`check check-${g.status}`}>
              <span className="check-icon">
                <Icon name={STATUS_ICON[g.status]} size={16} />
                <span className="sr-only">{STATUS_LABEL[g.status]}:</span>
              </span>
              <p className="check-title">{g.label}</p>
              <ul className="check-findings">
                {g.findings.map((f, i) => (
                  <li key={i} className={`finding finding-${f.status}`}>
                    {f.message}
                    {/* a fix button says what to do; the hint only when there is none */}
                    {f.hint && f.status !== "ok" && !g.fixes.length && <span className={`finding-hint${/^Run: /.test(f.hint) ? " is-command" : ""}`}>{f.hint}</span>}
                  </li>
                ))}
              </ul>
              {g.fixes.length > 0 && (
                <div className="check-actions">
                  {g.fixes.map((x) => (
                    <button key={x} type="button" className="btn btn-sm" onClick={() => setFix(x)}>
                      {FIX_LABELS[x]}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="raw-output">
          <p>Portplane couldn't read this portless's diagnosis, so here it is as portless printed it.</p>
          <pre className="mono">{report.raw || report.error}</pre>
        </div>
      )}
      {report.parsed && report.unparsed && report.unparsed.length > 0 && (
        <details className="raw-output">
          <summary>Lines Portplane didn't recognise ({report.unparsed.length})</summary>
          <pre className="mono">{report.unparsed.join("\n")}</pre>
        </details>
      )}
      <dl className="doctor-facts">
        {report.version && (
          <div>
            <dt>portless</dt>
            <dd className="mono">{report.version}</dd>
          </div>
        )}
        {report.node && (
          <div>
            <dt>Node.js</dt>
            <dd className="mono">{report.node}</dd>
          </div>
        )}
        {report.mode && (
          <div>
            <dt>Mode</dt>
            <dd>{report.mode}</dd>
          </div>
        )}
        {report.stateDir && (
          <div>
            <dt>State folder</dt>
            <dd>
              <ShortPath path={report.stateDir} />
            </dd>
          </div>
        )}
      </dl>
      {fix && (
        <PlanDialog action={fix} onClose={() => setFix(null)} onDone={(ok) => ok && run()}>
          {fix === "prune" && <StaleList force={false} />}
        </PlanDialog>
      )}
    </>
  );
}

/**
 * portless doctor as a checklist, with a fix for each failure (plan §5.8).
 * `onRun` tells the page it was asked to run (the palette's Run
 * diagnostics), so a page that folds it can show the result.
 */
export function DoctorSection({ onRun }: { onRun?(): void } = {}) {
  const { state, reload } = usePortlessDoctor(true);
  useIntent("run-doctor", () => {
    onRun?.();
    void reload();
  });
  const report = valueOf(state);
  const running = state.status === "loading";
  return (
    <StatusGate>
      {() =>
        report ? (
          <Report report={report} running={running} run={() => void reload()} at={state.status === "ok" ? state.at : undefined} />
        ) : state.status === "error" ? (
          <ErrorState title="Couldn't run portless doctor" message={state.error} onRetry={() => void reload()} />
        ) : (
          <LoadingState label="Running portless doctor…" />
        )
      }
    </StatusGate>
  );
}
