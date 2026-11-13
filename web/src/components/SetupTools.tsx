import type { Requirement, SetupCheck } from "../api/types";
import { missingRequirements, privilegeLabel } from "../lib/setup";
import { useApp } from "./AppContext";
import { CommandLine } from "./Controls";
import { useRemoteCommand } from "./MachineScope";
import { Icon, Spinner } from "./Icon";
import "./SetupApps.css";

export type CheckLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; check: SetupCheck };

function RequirementRow({ req, os }: { req: Requirement; os: string | undefined }) {
  const command = useRemoteCommand();
  if (req.ok) {
    // What's there takes one line (ADR-0032).
    return (
      <li className="req req-ok req-compact">
        <span className="req-icon">
          <Icon name="check" size={16} />
        </span>
        <div className="req-line">
          <span className="req-name">{req.name}</span>
          <span className="sr-only">installed</span>
          {req.version && <span className="req-version mono">{req.version}</span>}
          <span className="req-why" title={req.why}>
            {req.why}
          </span>
        </div>
      </li>
    );
  }
  return (
    <li className="req req-missing">
      <span className="req-icon">
        <Icon name="warning" size={16} />
      </span>
      <div className="req-body">
        <div className="req-line">
          <span className="req-name">{req.name}</span>
          <span className="sr-only">missing</span>
          {req.privilege && (
            <span className="tag tag-warn" title="Run this command as an administrator">
              <Icon name="shield" size={11} />
              {privilegeLabel(os)}
            </span>
          )}
        </div>
        <p className="req-why">{req.why}</p>
        {req.problem && <p className="req-problem">{req.problem}</p>}
        {req.commands && req.commands.length > 0 && (
          <div className="req-commands">
            {req.commands.map((c) => (
              <CommandLine key={c} command={command(c)} />
            ))}
          </div>
        )}
        {req.docs && (
          <a className="req-docs" href={req.docs} target="_blank" rel="noopener noreferrer">
            Install guide
            <Icon name="open" size={12} />
          </a>
        )}
      </div>
    </li>
  );
}

/** Step 1: what setup needs on this computer, with the commands to do it by hand; the guided setup installs them (ADR-0019). */
export function SetupTools({ load, rechecking }: { load: CheckLoad; rechecking: boolean }) {
  const { info } = useApp();
  if (load.status === "loading") {
    return (
      <p className="dialog-loading">
        <Spinner /> Checking what's installed…
      </p>
    );
  }
  if (load.status === "error") {
    return (
      <p className="field-error" role="alert">
        Couldn't check the tools: {load.message}
      </p>
    );
  }
  const { check } = load;
  const missing = missingRequirements(check);
  return (
    <div className="setup-step" aria-busy={rechecking || undefined}>
      <p className="setup-lead">
        {missing.length === 0 ? (
          <>Everything setup needs is installed.</>
        ) : check.ready ? (
          <>
            You can set this folder up now. {missing.length === 1 ? "One thing is" : `${missing.length} things are`} still missing for
            some apps to run.
          </>
        ) : (
          <>
            Install what's missing, then check again. The guided setup (Settings, General) can install the tools for you, without a terminal.
          </>
        )}
      </p>
      <ul className="req-list">
        {check.requirements.filter((r) => r.status !== "skipped" && r.status !== "info").map((r) => (
          <RequirementRow key={r.id} req={r} os={info?.os} />
        ))}
      </ul>
    </div>
  );
}
