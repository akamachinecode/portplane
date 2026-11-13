import { useState } from "react";
import { errorText, isStale } from "../../api/errors";
import type { Proposal } from "../../api/types";
import { useApp } from "../../components/AppContext";
import { Banner } from "../../components/Banner";
import { FileDiff } from "../../components/FileDiff";
import { Icon, Spinner } from "../../components/Icon";
import { LoadingState } from "../../components/States";
import { inferHome, shortenPath } from "../../lib/format";
import { applyMessage, changedFiles, NO_EDITS, writeBlocker } from "../../lib/setup";
import { useOnboarding } from "./context";
import { StepFooter, StepLayout } from "./parts";
import { describeProposal, nothingToWrite } from "./summary";

/** Step 7: the exact changes, in plain words and as a diff, then write. */
export function ReviewStep() {
  const { api, toast } = useApp();
  const { folders, scans, edits, setRoots, go } = useOnboarding();
  const [writing, setWriting] = useState(false);
  const [stale, setStale] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const home = inferHome(folders);

  const proposals = folders.map((f) => scans[f]?.proposal).filter((p): p is Proposal => !!p);
  const loading = folders.some((f) => !scans[f]?.proposal && !scans[f]?.error);
  const blockers = folders
    .map((f) => {
      const s = scans[f];
      if (!s?.proposal || changedFiles(s.proposal).length === 0) return null;
      const b = writeBlocker({ proposal: s.proposal, scannedKey: s.scannedKey, edits: edits[f] ?? NO_EDITS, scanning: s.scanning });
      return b ? `${shortenPath(f, home)}: ${b}` : null;
    })
    .filter((b): b is string => !!b);
  const nothing = proposals.length > 0 && nothingToWrite(proposals);
  const rootsOf = () => proposals.map((p) => p.root ?? p.folder);

  const write = async () => {
    setWriting(true);
    setError(null);
    setStale([]);
    const messages: string[] = [];
    try {
      for (const f of folders) {
        const s = scans[f];
        if (!s?.proposal || !s.scannedWith || changedFiles(s.proposal).length === 0) continue;
        try {
          const res = await api.setupApply(f, s.proposal.digest, s.scannedWith);
          // The next step starts the runner, so only a reload error is news.
          const msg = applyMessage(res);
          if (msg.kind === "error") toast.error(`${shortenPath(f, home)}: ${msg.text}`);
          else if (res.written.length) messages.push(`${shortenPath(f, home)}: ${res.written.length === 1 ? "one file" : `${res.written.length} files`}`);
        } catch (err) {
          if (isStale(err)) {
            setStale((cur) => [...cur, f]);
            await s.rescan();
            return;
          }
          throw err;
        }
      }
      if (messages.length) toast.info(`Config written (${messages.join("; ")}).`);
      setRoots(rootsOf());
      go("start");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWriting(false);
    }
  };

  return (
    <StepLayout
      title="Review and write"
      lead="What Portplane will write, in plain words; the exact lines are one click away."
      moreLabel="Where it goes"
      more={
        <p>
          Generated tasks go to <code>.portplane/tasks.yaml</code>, next to your <code>dekit.yaml</code>. Tasks you write by hand always win.
        </p>
      }
      busy={writing || loading}
      footer={
        <StepFooter status={blockers[0] ?? (nothing ? "Nothing to write: the config is up to date." : "")}>
          {nothing ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setRoots(rootsOf());
                go("start");
              }}
            >
              Next
              <Icon name="chevronRight" size={14} />
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void write()} disabled={writing || loading || blockers.length > 0 || proposals.length === 0} aria-busy={writing || undefined}>
              {writing ? <Spinner size={12} /> : <Icon name="check" size={14} />}
              Write the config
            </button>
          )}
        </StepFooter>
      }
    >
      {loading && proposals.length === 0 && <LoadingState label="Preparing the changes…" />}
      {stale.length > 0 && (
        <Banner tone="warn" title="A folder changed while you were reviewing">
          Portplane scanned it again. Check the new changes below, then write again.
        </Banner>
      )}
      {error && (
        <p className="field-error" role="alert">
          Couldn't write the config: {error}
        </p>
      )}
      {proposals.map((p) => {
        const lines = describeProposal(p, home);
        const files = changedFiles(p);
        return (
          <section key={p.folder} className="ob-review" aria-label={`Changes in ${shortenPath(p.folder, home)}`}>
            {proposals.length > 1 && (
              <h3 className="ob-folder-apps-title">
                <Icon name="folder" size={15} />
                <span className="mono">{shortenPath(p.folder, home)}</span>
              </h3>
            )}
            {lines.length ? (
              <ul className="ob-summary">
                {lines.map((l) => (
                  <li key={l}>{l}.</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nothing to change in {shortenPath(p.folder, home)}.</p>
            )}
            {files.length > 0 && (
              <details className="ob-more ob-review-lines">
                <summary>{files.length === 1 ? "See the file line by line" : `See the ${files.length} files line by line`}</summary>
                <div className="ob-more-body">
                  {files.map((f) => (
                    <FileDiff key={`${f.path}\u0000${p.digest}`} file={f} folder={p.folder} />
                  ))}
                </div>
              </details>
            )}
          </section>
        );
      })}
    </StepLayout>
  );
}
