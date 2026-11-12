import { useCallback, useEffect, useId, useState } from "react";
import type { DekitAbout as About } from "../../api/dekit";
import { errorText } from "../../api/errors";
import { useJob } from "../../api/jobs";
import { useApp } from "../../components/AppContext";
import { CommandLine, Field } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Icon, Spinner } from "../../components/Icon";
import { JobCard } from "../../components/JobCard";
import { Segmented } from "../../components/Segmented";
import { ErrorState, LoadingState } from "../../components/States";
import { shortenPath } from "../../lib/format";
import { openDekitHelp } from "./DekitHelp";

// dekit itself (plan §4.8): version, how it was installed, which binary
// runs projects (kernel), updating it, and its help.

const ORIGIN_LABEL: Record<About["origin"]["kind"], string> = {
  script: "dekit's install script",
  homebrew: "Homebrew",
  npm: "npm",
  pip: "pip",
  cargo: "cargo",
  other: "an unknown installer",
};

let lastUpdateJob: string | null = null;

function UpdateDialog({ about, onClose }: { about: About; onClose(): void }) {
  const { api, toast } = useApp();
  const [channel, setChannel] = useState<"latest" | "canary" | "version">("latest");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(lastUpdateJob);
  const job = useJob(jobId);
  const versionId = useId();
  const script = about.origin.kind === "script";
  const target = channel === "version" ? version.trim() : channel === "canary" ? "canary" : "";
  const command = script ? [...about.origin.update, ...(target ? [target] : [])].join(" ") : about.origin.update.join(" ");
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await api.dekitUpdate(target);
      lastUpdateJob = j.id;
      setJobId(j.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const running = job?.state === "running";
  return (
    <Dialog
      open
      onClose={onClose}
      title="Update dekit"
      size="md"
      dismissable={!busy}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {job && !running ? "Close" : "Cancel"}
          </button>
          {(!job || !running) && about.origin.update.length > 0 && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || (channel === "version" && !/^v?\d+\.\d+\.\d+$/.test(version.trim()))}
              aria-busy={busy || undefined}
              onClick={() => void run().then(() => toast.info("Updating dekit…"))}
            >
              {busy && <Spinner />}
              {job ? "Run again" : "Update"}
            </button>
          )}
        </>
      }
    >
      {about.origin.update.length === 0 ? (
        <p className="dialog-text">
          This dekit (<span className="mono">{about.path}</span>) came from {ORIGIN_LABEL[about.origin.kind]}, which Portplane can't drive. Update it the
          same way you installed it, then run <code>dekit runner upgrade --all</code> so running projects switch to it.
        </p>
      ) : (
        <>
          <p className="dialog-text">
            Installed with {ORIGIN_LABEL[about.origin.kind]}. {script ? "dekit updates itself and then switches the running runners; their tasks keep running." : "Portplane runs the package manager, then switches the running runners to the new binary."}
          </p>
          {script && (
            <>
              <Segmented<"latest" | "canary" | "version">
                label="Which version"
                value={channel}
                onChange={setChannel}
                options={[
                  { value: "latest", label: "Latest" },
                  { value: "canary", label: "Canary" },
                  { value: "version", label: "A version" },
                ]}
              />
              {channel === "canary" && <p className="field-hint">The newest build of dekit's main branch: early, and sometimes broken.</p>}
              {channel === "version" && (
                <Field label="Version" htmlFor={versionId} hint="Such as 0.10.2, to go back after a bad release.">
                  <input id={versionId} className="input mono" value={version} placeholder="0.10.2" onChange={(e) => setVersion(e.target.value)} />
                </Field>
              )}
            </>
          )}
          <p className="field-hint">It runs:</p>
          <CommandLine command={command} />
          {!script && about.origin.upgradeRunners && <CommandLine command="dekit runner upgrade --all" />}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {job && <JobCard job={job} lines={8} headingLevel={3} />}
        </>
      )}
    </Dialog>
  );
}

function KernelDialog({ about, onClose, onChanged }: { about: About; onClose(): void; onChanged(): void }) {
  const { api } = useApp();
  const [path, setPath] = useState(about.kernel?.default ?? about.path ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.dekitSetKernel(value);
      onChanged();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Default dekit binary"
      size="sm"
      dismissable={!busy}
      footer={
        <>
          {about.kernel?.default && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void save("")}>
              Clear the default
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !path.trim()} aria-busy={busy || undefined} onClick={() => void save(path.trim())}>
            {busy && <Spinner />}
            Make default
          </button>
        </>
      }
    >
      <p className="dialog-text">
        Projects without a <code>kernel:</code> of their own run this binary. A project's runner switches to it when you restart or upgrade it.
      </p>
      <Field label="Binary" htmlFor={id} error={error}>
        <input id={id} className="input mono" value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** The "dekit" card at the top of Runners. */
export function DekitAbout() {
  const { api } = useApp();
  const [about, setAbout] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: About }>({ status: "loading" });
  const [dialog, setDialog] = useState<"update" | "kernel" | null>(null);
  const load = useCallback(() => {
    api.dekitAbout().then(
      (value) => setAbout({ status: "ok", value }),
      (err: unknown) => setAbout({ status: "error", message: errorText(err) }),
    );
  }, [api]);
  useEffect(load, [load]);
  if (about.status === "loading") return <LoadingState label="Asking dekit about itself…" />;
  if (about.status === "error") return <ErrorState title="Couldn't read dekit's version" message={about.message} onRetry={load} />;
  const a = about.value;
  if (!a.installed) return null;
  const k = a.kernel;
  return (
    <section className="dk-about" aria-labelledby="dk-about-title">
      <div className="dk-about-head">
        <h2 id="dk-about-title" className="dk-about-title">
          dekit <span className="mono">{a.version}</span>
        </h2>
        <div className="dk-about-actions">
          <button type="button" className="btn btn-sm" onClick={() => openDekitHelp("index")}>
            <Icon name="book" size={13} />
            Help
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setDialog("update")}>
            <Icon name="arrowUp" size={13} />
            Update…
          </button>
        </div>
      </div>
      <dl className="dk-about-facts">
        <div>
          <dt>Installed with</dt>
          <dd>{ORIGIN_LABEL[a.origin.kind]}</dd>
        </div>
        <div>
          <dt>Binary</dt>
          <dd className="mono" title={a.path}>
            {shortenPath(a.path ?? "", undefined)}
          </dd>
        </div>
        <div>
          <dt>Default for projects</dt>
          <dd>
            <span className="mono">{k?.default ?? "the dekit on PATH"}</span>{" "}
            <button type="button" className="link-btn" onClick={() => setDialog("kernel")}>
              Change
            </button>
          </dd>
        </div>
        {k?.selection_error && (
          <div>
            <dt>Problem</dt>
            <dd className="dk-warn-error">{k.selection_error}</dd>
          </div>
        )}
      </dl>
      {dialog === "update" && <UpdateDialog about={a} onClose={() => setDialog(null)} />}
      {dialog === "kernel" && <KernelDialog about={a} onClose={() => setDialog(null)} onChanged={load} />}
    </section>
  );
}
