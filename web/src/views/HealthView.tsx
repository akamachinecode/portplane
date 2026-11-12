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
  const serious = problems.filter((p) => p.severity !== "info").length;
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
              {problems.length === 0 ? (
                <div className="all-clear">
                  <Icon name="checkCircle" size={18} />
                  <div>
                    <p className="all-clear-title">Nothing needs your attention</p>
                    <p className="all-clear-text">Every check below passes. Problems show here the moment they happen, with a way to fix each one.</p>
                  </div>
                </div>
              ) : (
                <ul className="problems" aria-label={`${problems.length} ${problems.length === 1 ? "problem" : "problems"}, most serious first`}>
                  {problems.map((p) => (
                    <ProblemRow key={p.id} problem={p} multiMachine={multiMachine} />
                  ))}
                </ul>
              )}
            </section>
            {local && (
              <section className="health-section" aria-labelledby="health-computer">
                <h2 className="health-title" id="health-computer">
                  This computer
                </h2>
                <SystemChecks ms={local} />
              </section>
            )}
            {local?.tools.portless && (
              <section className="health-section" aria-labelledby="health-doctor">
                <h2 className="health-title" id="health-doctor">
                  portless doctor
                </h2>
                <p className="health-text">portless checks its own setup: the proxy, its state folder, the certificate and how names resolve.</p>
                <DoctorSection />
              </section>
            )}
            {snap.machines.some((m) => !m.machine.local) && (
              <section className="health-section" aria-labelledby="health-machines">
                <h2 className="health-title" id="health-machines">
                  Other machines
                </h2>
                <MachineRows machines={snap.machines.filter((m) => !m.machine.local)} />
              </section>
            )}
          </>
        )}
      </SnapshotGate>
    </>
  );
}
