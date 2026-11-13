import { errorText } from "../api/errors";
import { useApp } from "../components/AppContext";
import { Icon, Spinner, type IconName } from "../components/Icon";
import type { MachineSnapshot } from "../api/types";
import { ViewHeader } from "../components/ViewHeader";
import { href } from "../lib/router";
import type { Problem, Severity } from "../shell/health";
import { SnapshotGate } from "../shell/SnapshotGate";
import { useShell } from "../shell/ShellContext";
import { DoctorSection } from "./domains/DoctorSection";
import { usePortlessDoctor } from "./domains/store";
import { CheckList, SystemChecks, useSystemCheck, type CheckRow } from "./health/SystemChecks";
import "./DomainsView.css";
import { ExportDiagnosticsButton } from "./health/ExportDiagnostics";
import "./HealthView.css";

const ICON: Record<Severity, IconName> = { error: "xCircle", warning: "warning", info: "info" };
const SEVERITY_LABEL: Record<Severity, string> = { error: "Error", warning: "Warning", info: "Note" };

function ProblemRow({ problem, multiMachine }: { problem: Problem; multiMachine: boolean }) {
  const app = useApp();
  const shell = useShell();
  const fix = problem.fix;
  const busy = fix?.pendingKey ? app.pending.has(fix.pendingKey) : false;
  return (
    <li className={`problem problem-${problem.severity}`}>
      <span className="problem-icon">
        <Icon name={ICON[problem.severity]} size={16} />
        <span className="sr-only">{SEVERITY_LABEL[problem.severity]}:</span>
      </span>
      <div className="problem-body">
        <p className="problem-title">
          {problem.title}
          {multiMachine && problem.machine && <span className="problem-machine">{problem.machine.name}</span>}
        </p>
        {problem.detail && <p className="problem-detail">{problem.detail}</p>}
        {problem.code && <code className="problem-code">{problem.code}</code>}
      </div>
      <div className="problem-actions">
        {problem.link && (
          <a className="btn btn-sm btn-ghost" href={href(problem.link.route)}>
            {problem.link.label}
          </a>
        )}
        {fix && (
          <button
            type="button"
            className="btn btn-sm"
            aria-busy={busy || undefined}
            disabled={busy}
            onClick={() => {
              Promise.resolve()
                .then(() => fix.run({ ...app, ...shell }))
                .catch((err: unknown) => app.toast.error(errorText(err)));
            }}
          >
            {busy && <Spinner size={12} />}
            {fix.label}
          </button>
        )}
      </div>
    </li>
  );
}

/** The other machines, one row each: reachable or not, and their tools. */
function MachineRows({ machines }: { machines: MachineSnapshot[] }) {
  const rows: CheckRow[] = machines.map((ms) => {
    const m = ms.machine;
    const online = m.status === "online";
    return {
      id: m.id,
      tone: online ? "ok" : m.status === "connecting" ? "warn" : "fail",
      title: m.name,
      detail: online ? [ms.tools.dekit && `dekit ${ms.tools.dekit}`, ms.tools.portless && `portless ${ms.tools.portless}`, ms.tools.proxyRunning ? "proxy running" : "proxy stopped"].filter(Boolean).join(" · ") : m.error || "Not connected",
      link: { label: "Machines", route: { view: "machines" } },
    };
  });
  return <CheckList rows={rows} label="Other machines" />;
}

/**
 * Health (plan §6.4, ADR-0028): what needs attention first, each with its
 * fix; then every check that passes, so the page always says how things
 * stand: tools, HTTPS and addresses, runners and apps, portless's own
 * doctor, and the other machines.
 */
export function HealthView() {
  const { problems, snapshot } = useShell();
  const local = snapshot?.machines.find((m) => m.machine.local);
  // Opening Health runs portless's own diagnostics and the setup check once,
  // so their findings join the page (they need a few seconds, so not at start).
  const doctor = usePortlessDoctor(!!local?.tools.portless);
  const check = useSystemCheck(true);
  // One count everywhere (ADR-0032): the problems (errors and warnings) are
  // what the sidebar's badge, the Apps line and this title count; notes are
  // listed apart and counted nowhere.
  const attention = problems.filter((p) => p.severity !== "info");
  const notes = problems.filter((p) => p.severity === "info");
  const serious = attention.length;
  const multiMachine = (snapshot?.machines.length ?? 0) > 1;
  const checking = check.state.status === "loading" || doctor.state.status === "loading";
  const again = () => {
    void check.reload();
    if (local?.tools.portless) void doctor.reload();
  };
  return (
    <>
      <ViewHeader
        title="Health"
        summary={
          !snapshot ? undefined : serious ? `${serious} ${serious === 1 ? "thing needs" : "things need"} your attention` : "Everything works"
        }
        description="What needs your attention first, each with its fix, then every check Portplane runs on this computer and its machines."
        actions={
          <>
            <button type="button" className="btn" onClick={again} disabled={checking} aria-busy={checking || undefined}>
              {checking ? <Spinner size={13} /> : <Icon name="restart" size={14} />}
              {checking ? "Checking…" : "Check again"}
            </button>
            <ExportDiagnosticsButton variant="ghost" />
          </>
        }
      />
      <SnapshotGate>
        {(snap) => (
          <>
            <section className="health-section" aria-labelledby="health-attention">
              <h2 className="health-title" id="health-attention">
                Needs attention
              </h2>
              {attention.length === 0 ? (
                <div className="all-clear">
                  <Icon name="checkCircle" size={18} />
                  <div>
                    <p className="all-clear-title">Nothing needs your attention</p>
                    <p className="all-clear-text">Problems show here the moment they happen, each with its fix.</p>
                  </div>
                </div>
              ) : (
                <ul className="problems" aria-label={`${attention.length} ${attention.length === 1 ? "problem" : "problems"}, most serious first`}>
                  {attention.map((p) => (
                    <ProblemRow key={p.id} problem={p} multiMachine={multiMachine} />
                  ))}
                </ul>
              )}
            </section>
            {notes.length > 0 && (
              <section className="health-section" aria-labelledby="health-notes">
                <h2 className="health-title" id="health-notes">
                  Good to know
                </h2>
                <ul className="problems problems-notes" aria-label={`${notes.length} ${notes.length === 1 ? "note" : "notes"}`}>
                  {notes.map((p) => (
                    <ProblemRow key={p.id} problem={p} multiMachine={multiMachine} />
                  ))}
                </ul>
              </section>
            )}
            {/* every check that runs, folded: it is the record, not the news */}
            <details className="health-section health-all">
              <summary className="health-all-summary">
                <Icon name="chevronRight" size={14} className="health-all-chevron" />
                <span className="health-title">Every check</span>
                <span className="health-all-hint">This computer{local?.tools.portless ? ", portless doctor" : ""}{snap.machines.some((m) => !m.machine.local) ? ", other machines" : ""}</span>
              </summary>
              {local && (
                <section className="health-sub" aria-labelledby="health-computer">
                  <h3 className="health-subtitle" id="health-computer">
                    This computer
                  </h3>
                  <SystemChecks ms={local} />
                </section>
              )}
              {local?.tools.portless && (
                <section className="health-sub" aria-labelledby="health-doctor">
                  <h3 className="health-subtitle" id="health-doctor">
                    portless doctor
                  </h3>
                  <DoctorSection />
                </section>
              )}
              {snap.machines.some((m) => !m.machine.local) && (
                <section className="health-sub" aria-labelledby="health-machines">
                  <h3 className="health-subtitle" id="health-machines">
                    Other machines
                  </h3>
                  <MachineRows machines={snap.machines.filter((m) => !m.machine.local)} />
                </section>
              )}
            </details>
          </>
        )}
      </SnapshotGate>
    </>
  );
}
