import { useId, useState } from "react";
import { errorText } from "../../api/errors";
import type { Requirement, SharingOverview } from "../../api/sharing";
import { useApp } from "../../components/AppContext";
import { CommandLine } from "../../components/Controls";
import { Icon, Spinner } from "../../components/Icon";
import { usePlan } from "./ProxySection";
import { sharingResource } from "./store";
import "./Sharing.css";

/** Pastes ngrok's authtoken; Portplane saves it with `ngrok config add-authtoken`. */
function NgrokToken({ onSaved }: { onSaved?(o: SharingOverview): void }) {
  const { api, toast } = useApp();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await api.portlessNgrokAuthtoken(token.trim());
      sharingResource.put(o);
      setToken("");
      toast.info("Saved the ngrok authtoken");
      onSaved?.(o);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="req-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim() && !busy) void save();
      }}
    >
      <label className="sr-only" htmlFor={id}>
        ngrok authtoken
      </label>
      <input
        id={id}
        className="input mono"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste your authtoken"
        value={token}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setToken(e.target.value)}
      />
      <button type="submit" className="btn btn-primary" disabled={!token.trim() || busy} aria-busy={busy || undefined}>
        {busy && <Spinner />}
        Save authtoken
      </button>
      {error && (
        <p className="field-error req-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * What a feature needs on this computer: each requirement met or not, and
 * for a missing one what's wrong, how to fix it (a command to copy, an
 * official page, or a fix Portplane runs itself).
 */
export function Requirements({ reqs, showMet = true, onChanged }: { reqs: Requirement[]; showMet?: boolean; onChanged?(): void }) {
  const { show, dialog } = usePlan();
  const list = showMet ? reqs : reqs.filter((r) => !r.ok);
  // The token goes in through ngrok itself: no form until ngrok is installed.
  const noNgrok = reqs.some((r) => r.id === "ngrok-installed" && !r.ok);
  if (!list.length) return null;
  return (
    <>
      <ul className="req-list reqs">
        {list.map((r) => (
          <li key={r.id} className={`req ${r.ok ? "req-ok" : "req-missing"}`}>
            <span className="req-icon" aria-hidden>
              <Icon name={r.ok ? "check" : "warning"} size={13} />
            </span>
            <div className="req-body">
              <p className="req-line">
                <span className="req-name">{r.label}</span>
                <span className="sr-only">{r.ok ? ": done" : ": missing"}</span>
              </p>
              {!r.ok && (
                <>
                  {r.problem && <p className="req-problem">{r.problem}</p>}
                  {r.fix && <p className="req-fix">{r.fix}</p>}
                  {r.action === "ngrok-authtoken" && !noNgrok && <NgrokToken onSaved={() => onChanged?.()} />}
                  {r.command && (r.action !== "ngrok-authtoken" || noNgrok) && <CommandLine command={r.command} />}
                  <div className="req-actions">
                    {r.action === "tailscale-operator" && (
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => show("tailscale-operator")}>
                        <Icon name="shield" size={13} />
                        Fix it…
                      </button>
                    )}
                    {r.url && (
                      <a className="btn btn-sm" href={r.url} target="_blank" rel="noopener noreferrer">
                        <Icon name="open" size={13} />
                        {r.action === "ngrok-authtoken" ? "Get your authtoken" : "Open the page"}
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {dialog}
    </>
  );
}
