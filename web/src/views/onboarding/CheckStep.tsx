import type { Requirement, RequirementId } from "../../api/types";
import { Icon, Spinner } from "../../components/Icon";
import { useMachineScope, useRemoteCommand } from "../../components/MachineScope";
import { useOnboarding } from "./context";
import { CopyCommand, Mark, NextButton, StepFooter, StepLayout } from "./parts";
import { CHECK_ORDER, firstFixStep, problems, statusOf } from "./steps";

const PENDING_NAME: Record<RequirementId, string> = {
  dekit: "dekit",
  node: "Node.js",
  portless: "portless",
  git: "git",
  packages: "Package managers",
  port: "Port 443",
  proxy: "The proxy",
  ca: "The local certificate",
  hosts: "/etc/hosts",
  lan: "LAN tools",
  path: "Your terminal's PATH",
  tray: "Tray icon",
  portplane: "portplane on PATH",
};

const FIXABLE = new Set(["install-dekit", "install-node", "install-portless", "proxy", "reinstall-service", "trust-system", "trust-browsers", "path-profile", "use-1355"]);

function CheckRow({ id, req, pending, error }: { id: RequirementId; req?: Requirement; pending: boolean; error?: string }) {
  const command = useRemoteCommand();
  if (!req) {
    return (
      <li className="ob-check is-pending">
        {error ? <Mark tone="warn" label="Couldn't check" /> : <Mark tone="busy" label="Checking" />}
        <div className="ob-check-body">
          <p className="ob-check-name">{PENDING_NAME[id]}</p>
          <p className="ob-check-detail muted">{error ? `Couldn't check: ${error}` : "Checking…"}</p>
        </div>
      </li>
    );
  }
  const s = statusOf(req);
  const tone = s === "ok" ? "ok" : s === "info" ? "info" : s === "warning" ? "warn" : "bad";
  const label = { ok: "Ready", info: "Note", warn: "Worth fixing", bad: "Needs fixing" }[tone];
  return (
    <li className={`ob-check ob-check-${tone}`} aria-busy={pending || undefined}>
      {pending ? <Mark tone="busy" label="Checking again" /> : <Mark tone={tone} label={label} />}
      <div className="ob-check-body">
        <p className="ob-check-name">
          {req.name}
          {req.version && <span className="ob-check-version mono">{req.version}</span>}
          {req.fix && FIXABLE.has(req.fix) && s !== "ok" && s !== "info" && <span className="tag ob-tag-fix">Portplane can fix this</span>}
          {req.privilege && s !== "ok" && s !== "info" && (
            <span className="tag tag-warn" title="Asks for your administrator password">
              <Icon name="shield" size={11} />
              password
            </span>
          )}
        </p>
        {req.detail && <p className="ob-check-detail">{req.detail}</p>}
        {req.problem && <p className="ob-check-problem">{req.problem}</p>}
        {s !== "ok" && !req.fix && req.commands && req.commands.length > 0 && (
          <div className="ob-check-commands">
            {req.commands.map((c) =>
              c.startsWith("https://") ? (
                <a key={c} className="ob-link" href={c} target="_blank" rel="noopener noreferrer">
                  Get it from extensions.gnome.org
                  <Icon name="open" size={12} />
                </a>
              ) : (
                <CopyCommand key={c} command={command(c)} />
              ),
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Step 2: every check at once, each answer as it comes. */
export function CheckStep() {
  const { checks, go, flow } = useOnboarding();
  const scope = useMachineScope();
  const remote = scope.remote ? (scope.ms?.machine.name ?? scope.id) : null;
  // A machine over SSH has no tray icon to check.
  const shown = CHECK_ORDER.filter((id) => !(remote && id === "tray")).filter((id) => {
    const r = checks.items[id];
    return !r || statusOf(r) !== "skipped";
  }).filter((id) => checks.items[id] || checks.pending.has(id) || checks.errors[id]);
  const known = shown.map((id) => checks.items[id]).filter((r): r is Requirement => !!r);
  const running = checks.pending.size > 0;
  const issues = problems(known);
  const required = issues.filter((r) => !r.optional);
  const optional = issues.filter((r) => r.optional);
  const anyFix = issues.some((r) => r.fix && FIXABLE.has(r.fix));

  let status: string;
  if (running && known.length < shown.length) status = `Checking… ${known.length} of ${shown.length}`;
  else if (required.length === 0 && optional.length === 0) status = "Everything is ready.";
  else if (required.length === 0) status = optional.length === 1 ? "Ready, with one suggestion." : `Ready, with ${optional.length} suggestions.`;
  else status = required.length === 1 ? "One thing to fix." : `${required.length} things to fix.`;

  return (
    <StepLayout
      icon="pulse"
      title={remote ? `Check ${remote}` : "Check your computer"}
      lead={
        remote
          ? `Portplane looks at what's installed on ${remote} and how its proxy stands, over SSH. Nothing changes until you choose to fix something.`
          : "Portplane looks at what's installed and how the proxy and certificate stand. Nothing changes until you choose to fix something."
      }
      busy={running}
      footer={
        <StepFooter status={status}>
          <button type="button" className="btn" onClick={() => void checks.run()} disabled={running} aria-busy={running || undefined}>
            {running ? <Spinner size={12} /> : <Icon name="restart" size={14} />}
            Check again
          </button>
          {anyFix ? (
            <button type="button" className="btn btn-primary" onClick={() => go(firstFixStep(flow))} disabled={running && known.length < 3}>
              <Icon name="wand" size={14} />
              Fix everything
            </button>
          ) : (
            <NextButton disabled={running && known.length < 3} />
          )}
        </StepFooter>
      }
    >
      <ul className="ob-checks" aria-label="Checks" aria-live="polite">
        {shown.map((id) => (
          <CheckRow key={id} id={id} req={checks.items[id]} pending={checks.pending.has(id)} error={checks.errors[id]} />
        ))}
      </ul>
      {!running && required.length === 0 && optional.length > 0 && (
        <p className="muted ob-note">Suggestions don't block anything: you can come back to them from Settings.</p>
      )}
    </StepLayout>
  );
}
