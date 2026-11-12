import { errorText } from "../api/errors";
import { useApp } from "../components/AppContext";
import { Icon, Spinner, type IconName } from "../components/Icon";
import { EmptyState } from "../components/States";
import { ViewHeader } from "../components/ViewHeader";
import { href } from "../lib/router";
import type { Problem, Severity } from "../shell/health";
import { SnapshotGate } from "../shell/SnapshotGate";
import { useShell } from "../shell/ShellContext";
import { usePortlessDoctor } from "./domains/store";
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
            className="btn btn-sm btn-primary"
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

/** Every problem in one list, each with its fix where there is one (plan §6.4). */
export function HealthView() {
  const { problems, snapshot } = useShell();
  // Opening Health runs portless's own diagnostics once, so its findings
  // join the list (they need a few seconds, so not at start).
  usePortlessDoctor(!!snapshot?.machines.find((m) => m.machine.local)?.tools.portless);
  const serious = problems.filter((p) => p.severity !== "info").length;
  const multiMachine = (snapshot?.machines.length ?? 0) > 1;
  return (
    <>
      <ViewHeader
        title="Health"
        description={
          !snapshot ? undefined : serious ? `${serious} ${serious === 1 ? "thing needs" : "things need"} your attention.` : "Nothing needs your attention."
        }
        actions={<ExportDiagnosticsButton variant="ghost" />}
      />
      <SnapshotGate>
        {() =>
          problems.length === 0 ? (
            <EmptyState icon="checkCircle" title="Everything looks good">
              Tools, the proxy, runners, apps and machines are all fine.
            </EmptyState>
          ) : (
            <ul className="problems" aria-label={`${problems.length} ${problems.length === 1 ? "problem" : "problems"}, most serious first`}>
              {problems.map((p) => (
                <ProblemRow key={p.id} problem={p} multiMachine={multiMachine} />
              ))}
            </ul>
          )
        }
      </SnapshotGate>
    </>
  );
}
