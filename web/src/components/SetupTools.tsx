import type { Requirement, SetupCheck } from "../api/types";
import { missingRequirements, privilegeLabel } from "../lib/setup";
import { useApp } from "./AppContext";
import { CommandLine } from "./Controls";
import { Icon, Spinner } from "./Icon";

export type CheckLoad = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; check: SetupCheck };

function RequirementRow({ req, os }: { req: Requirement; os: string | undefined }) {
  return (
    <li className={`req${req.ok ? " req-ok" : " req-missing"}`}>
      <span className="req-icon">
        <Icon name={req.ok ? "check" : "warning"} size={16} />
      </span>
      <div className="req-body">
        <div className="req-line">
          <span className="req-name">{req.name}</span>
          <span className="sr-only">{req.ok ? "installed" : "missing"}</span>
          {req.ok && req.version && <span className="req-version mono">{req.version}</span>}
          {!req.ok && req.privilege && (
            <span className="tag tag-warn" title="Run this command as an administrator">
              <Icon name="shield" size={11} />
              {privilegeLabel(os)}
            </span>
          )}
        </div>
        <p className="req-why">{req.why}</p>
        {!req.ok && req.problem && <p className="req-problem">{req.problem}</p>}
        {!req.ok && req.commands && req.commands.length > 0 && (
          <div className="req-commands">
            {req.commands.map((c) => (
              <CommandLine key={c} command={c} />
            ))}
          </div>
        )}
        {!req.ok && req.docs && (
          <a className="req-docs" href={req.docs} target="_blank" rel="noopener noreferrer">
            Install guide
            <Icon name="open" size={12} />
          </a>
        )}
      </div>
    </li>
  );
}

/** Step 1: what setup needs on this computer. Portplane shows commands, it never runs them (ADR-0014). */
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
            Install what's missing, then re-check. Portplane only shows the commands: run them in a terminal yourself.
          </>
        )}
      </p>
      <ul className="req-list">
        {check.requirements.map((r) => (
          <RequirementRow key={r.id} req={r} os={info?.os} />
        ))}
      </ul>
    </div>
  );
}
