import { useEffect, useId, useState } from "react";
import { ApiError, errorText } from "../../api/errors";
import { useJob } from "../../api/jobs";
import type { SharePreview, ShareKind } from "../../api/sharing";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Dialog } from "../../components/Dialog";
import { FileDiff } from "../../components/FileDiff";
import { Icon, Spinner } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { JobCard } from "../../components/JobCard";
import { ErrorState, LoadingState } from "../../components/States";
import { SHARE_BLURBS, SHARE_NAMES, SHARE_TITLES } from "../../lib/sharing";
import { Requirements } from "./Requirements";
import "./Sharing.css";
// Its styles live with the Domains view, which may not have loaded (the app detail opens this too).
import "../DomainsView.css";

function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

export interface ShareTarget {
  machine: string;
  appId: string;
  label: string;
  runner?: string;
}

/**
 * Turns one share of an app on or off (plan §5.8): what's still missing,
 * the exact change to the app's command, and for a public share an
 * explicit confirmation that the app becomes reachable from the internet.
 * Applying runs a job that restarts the app and waits for the address.
 */
export function ShareDialog({ target, kind, on, onClose }: { target: ShareTarget; kind: ShareKind; on: boolean; onClose(): void }) {
  const ctx = useApp();
  const { api, toast } = ctx;
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  const confirmId = useId();

  const load = () => {
    setError(null);
    setPreview(null);
    api.portlessSharePreview(target.machine, target.appId, kind, on).then(setPreview, (err: unknown) => setError(errorText(err)));
  };
  useEffect(load, [api, target.machine, target.appId, kind, on]);

  const result = job?.state === "succeeded" ? (job.result as { url?: string } | undefined) : undefined;
  useEffect(() => {
    if (job?.state !== "succeeded") return;
    toast.info(on ? `${target.label} is shared${result?.url ? ` at ${result.url}` : ""}` : `${target.label} isn't shared with ${SHARE_NAMES[kind]} any more`);
  }, [job?.state]);

  const apply = async () => {
    if (!preview?.digest) return;
    setStarting(true);
    setApplyError(null);
    try {
      const j = await api.portlessShare(target.machine, target.appId, kind, on, preview.digest, preview.public && confirmed);
      setJobId(j.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setApplyError("The file changed since this preview. Check the new preview, then try again.");
        load();
      } else {
        setApplyError(errorText(err));
      }
    } finally {
      setStarting(false);
    }
  };

  const title = on ? SHARE_TITLES[kind] : `Stop sharing with ${SHARE_NAMES[kind]}`;
  const ready = !!preview && !preview.problem && !!preview.digest && (!preview.public || confirmed);
  const verb = on ? (preview?.public ? "Share publicly" : "Share") : "Stop sharing";

  const footer = jobId ? (
    <>
      <span className="spacer" />
      <button type="button" className="btn" onClick={onClose}>
        {job && job.state !== "running" ? "Close" : "Hide"}
      </button>
    </>
  ) : (
    <>
      <span className="spacer" />
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
      {preview && !preview.problem && (
        <button type="button" className={`btn ${preview.public ? "btn-danger" : "btn-primary"}`} disabled={!ready || starting} aria-busy={starting || undefined} onClick={() => void apply()}>
          {starting ? <Spinner /> : <Icon name={on ? "share" : "stop"} size={13} />}
          {verb}
        </button>
      )}
    </>
  );

  return (
    <Dialog open onClose={onClose} title={`${title}: ${target.label}`} size="md" footer={footer}>
      {error && <ErrorState title="Couldn't prepare this" message={error} onRetry={load} />}
      {!error && !preview && <LoadingState label="Working out what changes…" />}
      {preview && !jobId && (
        <div className="share-dialog">
          <p className="plan-summary">{on ? SHARE_BLURBS[kind] : `${target.label} stops being reachable at its ${SHARE_NAMES[kind]} address. Its .localhost address keeps working.`}</p>
          {preview.problem && (
            <div className="share-problem" role="alert">
              <p>{preview.problem}</p>
              {preview.missing.length > 0 && <Requirements reqs={preview.missing} onChanged={load} />}
              {preview.missing.length > 0 && (
                <button type="button" className="btn btn-sm" onClick={load}>
                  <Icon name="restart" size={13} />
                  Check again
                </button>
              )}
            </div>
          )}
          {!preview.problem && (
            <>
              {/* red for what makes an app public; the rest is information, in plain text */}
              {preview.warnings.map((w) => {
                const exposure = preview.public && w.startsWith("Anyone");
                return (
                  <p key={w} className={`rename-note${exposure ? " share-public-warn" : ""}`}>
                    <Icon name={exposure ? "warning" : "info"} size={13} />
                    {w}
                  </p>
                );
              })}
              {preview.public && (
                <label className="share-confirm" htmlFor={confirmId}>
                  <input id={confirmId} type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-autofocus />
                  <span>
                    I understand <strong>{target.label}</strong> becomes reachable from the internet while it's shared.
                  </span>
                </label>
              )}
              {preview.files.length > 0 && (
                <div className="rename-diff">
                  <h3 className="plan-title">The change</h3>
                  {preview.files.map((f) => (
                    <FileDiff key={f.path} file={f} folder={target.runner ?? dirOf(f.path)} />
                  ))}
                </div>
              )}
              <h3 className="plan-title">What happens</h3>
              <ol className="rename-steps">
                {preview.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </>
          )}
          {applyError && (
            <p className="field-error" role="alert">
              {applyError}
            </p>
          )}
        </div>
      )}
      {job && (
        <div className="plan-job">
          <JobCard job={job} lines={8} />
          {result?.url && (
            <div className="share-result">
              <p>
                {target.label} is shared at{" "}
                <a className="addr" href={result.url} target="_blank" rel="noopener noreferrer">
                  {result.url.replace(/^https?:\/\//, "")}
                </a>
              </p>
              <IconButton icon="copy" label="Copy the shared address" onClick={() => void copyWithToast(ctx, result.url!, "the shared address")} />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
