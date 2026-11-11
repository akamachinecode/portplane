import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, isStale } from "../api/errors";
import { useSetupProposal } from "../hooks/useSetupProposal";
import { inferHome, shortenPath } from "../lib/format";
import {
  applyMessage,
  changedFiles,
  countsText,
  missingRequirements,
  NO_EDITS,
  proposalCounts,
  writeBlocker,
  type SetupEdits,
} from "../lib/setup";
import { useApp } from "./AppContext";
import { Banner } from "./Banner";
import { Dialog } from "./Dialog";
import { FileDiff } from "./FileDiff";
import { Icon, Spinner } from "./Icon";
import { SetupApps } from "./SetupApps";
import { SetupTools, type CheckLoad } from "./SetupTools";

type Step = "tools" | "apps" | "files";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "tools", label: "Tools" },
  { id: "apps", label: "Apps" },
  { id: "files", label: "Review and write" },
];

/**
 * Setup for one watched folder (M2, ADR-0009, ADR-0014): check the tools,
 * review the apps a scan found, then the exact file changes, and write.
 * Mounted only while open, so every opening starts fresh.
 */
export function SetupDialog({ folder, onClose }: { folder: string; onClose(): void }) {
  const { api, toast } = useApp();
  const [step, setStep] = useState<Step>("tools");
  const moved = useRef(false); // the user picked a step: stop choosing for them
  const [check, setCheck] = useState<CheckLoad>({ status: "loading" });
  const [rechecking, setRechecking] = useState(false);
  const [edits, setEdits] = useState<SetupEdits>(NO_EDITS);
  const scan = useSetupProposal(api, folder, edits);
  const [writing, setWriting] = useState(false);
  const [stale, setStale] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    try {
      const c = await api.setupCheck();
      setCheck({ status: "ok", check: c });
      // Nothing blocking: go straight to the apps the scan found.
      if (c.ready && !moved.current) setStep("apps");
    } catch (err) {
      setCheck({ status: "error", message: errorText(err) });
    }
  }, [api]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const recheck = async () => {
    setRechecking(true);
    moved.current = true;
    await runCheck();
    setRechecking(false);
  };

  const go = (s: Step) => {
    moved.current = true;
    setStep(s);
  };

  const onName = (task: string, value: string | undefined) => {
    setStale(false);
    setEdits((e) => {
      const names = { ...e.names };
      if (value === undefined) delete names[task];
      else names[task] = value;
      return { ...e, names };
    });
  };
  const onInclude = (task: string, include: boolean) => {
    setStale(false);
    setEdits((e) => ({ ...e, skip: { ...e.skip, [task]: !include } }));
  };

  const blocker = writeBlocker({ proposal: scan.proposal, scannedKey: scan.scannedKey, edits, scanning: scan.scanning });

  const write = async () => {
    if (blocker || writing || !scan.proposal || !scan.scannedWith) return;
    setWriting(true);
    setWriteError(null);
    try {
      const res = await api.setupApply(folder, scan.proposal.digest, scan.scannedWith);
      const msg = applyMessage(res);
      if (msg.kind === "error") toast.error(msg.text);
      else toast.info(msg.text);
      onClose();
    } catch (err) {
      if (isStale(err)) {
        // Someone changed the folder since the scan: show the new diff, ask again.
        setStale(true);
        await scan.rescan();
      } else {
        setWriteError(errorText(err));
      }
    } finally {
      setWriting(false);
    }
  };

  const ready = check.status === "ok" && check.check.ready;
  const missing = check.status === "ok" ? missingRequirements(check.check) : [];
  const available = (s: Step) => s !== "files" || scan.proposal !== null;
  const done = (s: Step) => (s === "tools" ? ready && step !== "tools" : s === "apps" ? step === "files" : false);
  const title = `Set up ${shortenPath(folder, inferHome([folder]))}`;

  const stepper = (
    <nav className="steps" aria-label="Setup steps">
      <ol>
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`step${step === s.id ? " is-current" : ""}${done(s.id) ? " is-done" : ""}`}
              aria-current={step === s.id ? "step" : undefined}
              disabled={!available(s.id)}
              onClick={() => go(s.id)}
            >
              <span className="step-num" aria-hidden="true">
                {done(s.id) ? <Icon name="check" size={12} /> : i + 1}
              </span>
              <span className="step-label">{s.label}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );

  const status = (text: string | null) =>
    text ? (
      <span className="setup-status" role="status">
        {scan.scanning && <Spinner size={12} />}
        {text}
      </span>
    ) : (
      <span className="spacer" />
    );

  let footer;
  if (step === "tools") {
    footer = (
      <>
        <button type="button" className="btn" onClick={recheck} disabled={rechecking || check.status === "loading"} aria-busy={rechecking || undefined}>
          {rechecking ? <Spinner /> : <Icon name="restart" size={14} />}
          Re-check
        </button>
        <span className="spacer" />
        <button type="button" className={ready ? "btn btn-primary" : "btn"} onClick={() => go("apps")}>
          {ready ? "Next: apps" : "Continue anyway"}
          <Icon name="chevronRight" size={14} />
        </button>
      </>
    );
  } else if (step === "apps") {
    footer = (
      <>
        <button type="button" className="btn btn-ghost" onClick={() => go("tools")}>
          Back
        </button>
        {status(scan.proposal ? countsText(proposalCounts(scan.proposal)) : scan.scanning ? "Scanning…" : null)}
        <button type="button" className="btn btn-primary" onClick={() => go("files")} disabled={!scan.proposal}>
          Next: review changes
          <Icon name="chevronRight" size={14} />
        </button>
      </>
    );
  } else {
    const files = scan.proposal ? changedFiles(scan.proposal) : [];
    footer = (
      <>
        <button type="button" className="btn btn-ghost" onClick={() => go("apps")} disabled={writing}>
          Back
        </button>
        {status(blocker ?? (files.length === 1 ? "Writes 1 file" : `Writes ${files.length} files`))}
        <button type="button" className="btn btn-primary" onClick={write} disabled={blocker !== null || writing} aria-busy={writing || undefined}>
          {writing ? <Spinner /> : <Icon name="check" size={14} />}
          Write config
        </button>
      </>
    );
  }

  return (
    <Dialog open onClose={onClose} title={title} head={stepper} footer={footer} size="full" dismissable={!writing}>
      {step === "tools" && <SetupTools load={check} rechecking={rechecking} />}

      {step === "apps" && (
        <>
          {missing.length > 0 && ready && (
            <Banner
              tone="info"
              title={`Still missing: ${missing.map((r) => r.name).join(", ")}`}
              action={
                <button type="button" className="btn btn-sm" onClick={() => go("tools")}>
                  See how to fix
                </button>
              }
            >
              Some apps may not start until it's installed.
            </Banner>
          )}
          {scan.error && (
            <Banner
              tone="error"
              title="Couldn't scan this folder"
              action={
                <button type="button" className="btn" onClick={() => void scan.rescan()} disabled={scan.scanning}>
                  Try again
                </button>
              }
            >
              {scan.error}
            </Banner>
          )}
          {scan.proposal ? (
            <SetupApps proposal={scan.proposal} edits={edits} onName={onName} onInclude={onInclude} />
          ) : (
            !scan.error && (
              <p className="dialog-loading">
                <Spinner /> Looking for apps in <span className="mono">{folder}</span>…
              </p>
            )
          )}
        </>
      )}

      {step === "files" && scan.proposal && (
        <div className="setup-step">
          {stale && (
            <Banner tone="warn" title="The folder changed while you were reviewing">
              Portplane scanned it again. Check the new changes below, then write again.
            </Banner>
          )}
          <p className="setup-lead">
            Generated tasks go to <code>.portplane/tasks.yaml</code>, loaded from <code>dekit.yaml</code>. Tasks you write by hand in{" "}
            <code>dekit.yaml</code> always win.
          </p>
          {[...scan.proposal.files]
            .sort((a, b) => Number(b.changed) - Number(a.changed))
            .map((f) => (
              <FileDiff key={`${f.path}\u0000${scan.proposal!.digest}`} file={f} folder={folder} />
            ))}
          {writeError && (
            <p className="field-error" role="alert">
              Couldn't write the config: {writeError}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
