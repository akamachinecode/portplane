import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { errorText, isAbort } from "../api/errors";
import type { MachineCandidate, MachineSettings } from "../api/types";
import { cleanFolders, defaultMachineName, groupCandidates, hostProblem, osLabel, remoteFolderProblem } from "../lib/machines";
import { useApp } from "./AppContext";
import { Banner } from "./Banner";
import { Field, PathRows } from "./Controls";
import { ConfirmDialog, Dialog } from "./Dialog";
import { Spinner } from "./Icon";
import { StateDot } from "./StateDot";

const FOLDER_PLACEHOLDER = "/home/you/code";

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: T };

function useElapsed(running: boolean): string {
  const [start, setStart] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    setStart(t0);
    setNow(t0);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.round((now - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function CandidateButton({ c, added, selected, disabled, onPick }: { c: MachineCandidate; added?: MachineSettings; selected: boolean; disabled: boolean; onPick(): void }) {
  const os = osLabel(c.os);
  return (
    <button type="button" className="cand" aria-pressed={selected} disabled={disabled || added !== undefined} onClick={onPick}>
      {c.online !== undefined && <StateDot state={c.online ? "online" : "off"} />}
      <span className="cand-name">{c.name}</span>
      {c.host !== c.name && <span className="cand-host mono">{c.host}</span>}
      <span className="cand-meta">
        {added ? (
          <span className="tag">added</span>
        ) : (
          <>
            {os && <span>{os}</span>}
            {c.online !== undefined && <span className={c.online ? "cand-online" : undefined}>{c.online ? "online" : "offline"}</span>}
          </>
        )}
      </span>
    </button>
  );
}

/** Add a machine over SSH (ADR-0015): pick a host or type one, name it, choose its folders. */
export function AddMachineDialog({ onClose }: { onClose(): void }) {
  const { api, toast } = useApp();
  const [cands, setCands] = useState<Load<{ list: MachineCandidate[]; saved: MachineSettings[] }>>({ status: "loading" });
  const [host, setHost] = useState("");
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([""]);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const hostId = useId();
  const nameId = useId();
  const elapsed = useElapsed(busy);

  useEffect(() => {
    let live = true;
    Promise.all([api.machineCandidates(), api.machines()]).then(
      ([list, saved]) => live && setCands({ status: "ok", value: { list, saved } }),
      (err: unknown) => live && setCands({ status: "error", message: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [api]);

  // Closing while ssh runs cancels it (the server stops when the request goes away).
  useEffect(() => () => abort.current?.abort(), []);

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  const hostErr = touched ? hostProblem(host) : null;
  const folderErrs = folders.map(remoteFolderProblem).filter(Boolean);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (hostProblem(host) || folderErrs.length || busy) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setError(null);
    try {
      const mc = await api.addMachine({ host: host.trim(), name: name.trim(), folders: cleanFolders(folders) }, ctl.signal);
      toast.info(`Added ${mc.name}. Its dev servers show up here once it connects.`);
      onClose();
    } catch (err) {
      if (!isAbort(err)) setError(errorText(err));
    } finally {
      if (abort.current === ctl) abort.current = null;
      setBusy(false);
    }
  };

  const cancelRequest = () => abort.current?.abort();
  const groups = cands.status === "ok" ? groupCandidates(cands.value.list, cands.value.saved) : [];

  return (
    <Dialog
      open
      onClose={close}
      title="Add a machine"
      dismissable={!busy}
      footer={
        <>
          <span className="spacer" />
          {busy ? (
            <button type="button" className="btn btn-ghost" onClick={cancelRequest}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={close}>
              Cancel
            </button>
          )}
          <button type="submit" form={`${hostId}-form`} className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>
            {busy && <Spinner />}
            {busy ? "Adding…" : "Add machine"}
          </button>
        </>
      }
    >
      <p className="dialog-text">
        Portplane connects with your own <code>ssh</code>, keys and <code>~/.ssh/config</code>, copies its agent to{" "}
        <code>~/.cache/portplane</code> there, and shows that machine's dev servers here. macOS and Linux.
      </p>

      <section className="cand-section" aria-label="Hosts found">
        {cands.status === "loading" && (
          <p className="dialog-loading">
            <Spinner /> Looking in ~/.ssh/config and Tailscale…
          </p>
        )}
        {cands.status === "error" && <p className="muted">Couldn't list hosts ({cands.message}). Type one below.</p>}
        {cands.status === "ok" && groups.length === 0 && <p className="muted">No hosts in ~/.ssh/config or Tailscale. Type one below.</p>}
        {groups.map((g) => (
          <div key={g.source} className="cand-group" role="group" aria-label={g.title}>
            <h3 className="cand-title">{g.title}</h3>
            <div className="cand-list">
              {g.items.map(({ candidate: c, added }) => (
                <CandidateButton
                  key={`${g.source}:${c.host}`}
                  c={c}
                  added={added}
                  selected={host.trim() === c.host}
                  disabled={busy}
                  onPick={() => {
                    setHost(c.host);
                    setError(null);
                    document.getElementById(`${hostId}-folders`)?.querySelector("input")?.focus();
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      <form id={`${hostId}-form`} className="form-grid" onSubmit={submit} noValidate>
        <Field label="SSH host" htmlFor={hostId} hint="An alias from ~/.ssh/config, or user@host." error={hostErr} errorId={`${hostId}-err`}>
          <input
            id={hostId}
            className="input mono"
            type="text"
            value={host}
            placeholder="box or you@box.local"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            disabled={busy}
            aria-invalid={hostErr ? true : undefined}
            aria-describedby={hostErr ? `${hostId}-err` : undefined}
            onChange={(e) => {
              setHost(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field label="Display name" htmlFor={nameId} hint="Optional. Also part of its URLs: https://web.<name>.localhost.">
          <input
            id={nameId}
            className="input"
            type="text"
            value={name}
            placeholder={defaultMachineName(host) || "box"}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="field" id={`${hostId}-folders`}>
          <span className="field-label">Folders on that machine</span>
          <PathRows values={folders} onChange={setFolders} problem={remoteFolderProblem} placeholder={FOLDER_PLACEHOLDER} disabled={busy} label="Folder on that machine" />
          <p className="field-hint">Where its projects live. Leave it empty to see only its open ports for now.</p>
        </div>
      </form>

      {busy && (
        <div className="progress-note" role="status">
          <Spinner />
          <span>
            Connecting over SSH and installing the agent… this can take a minute.
            <span className="progress-time"> {elapsed}</span>
          </span>
        </div>
      )}
      {error && (
        <Banner tone="error" title={`Couldn't add ${host.trim() || "the machine"}`}>
          <pre className="error-pre">{error}</pre>
        </Banner>
      )}
    </Dialog>
  );
}

/** Rename a machine or change which of its folders Portplane watches. */
export function EditMachineDialog({ id, onClose }: { id: string; onClose(): void }) {
  const { api, toast } = useApp();
  const [load, setLoad] = useState<Load<MachineSettings>>({ status: "loading" });
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([""]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameId = useId();

  useEffect(() => {
    let live = true;
    api.machines().then(
      (list) => {
        if (!live) return;
        const mc = list.find((m) => m.id === id);
        if (!mc) {
          setLoad({ status: "error", message: "This machine isn't in the settings any more." });
          return;
        }
        setLoad({ status: "ok", value: mc });
        setName(mc.name);
        setFolders(mc.folders.length ? mc.folders : [""]);
      },
      (err: unknown) => live && setLoad({ status: "error", message: errorText(err) }),
    );
    return () => {
      live = false;
    };
  }, [api, id]);

  const bad = folders.some((f) => remoteFolderProblem(f) !== null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (bad || saving || load.status !== "ok") return;
    setSaving(true);
    setError(null);
    try {
      const mc = await api.updateMachine(id, { name: name.trim() || undefined, folders: cleanFolders(folders) });
      toast.info(`Saved ${mc.name}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const mc = load.status === "ok" ? load.value : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={mc ? `Edit ${mc.name}` : "Edit machine"}
      dismissable={!saving}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={`${nameId}-form`} className="btn btn-primary" disabled={!mc || bad || saving} aria-busy={saving || undefined}>
            {saving && <Spinner />}
            Save
          </button>
        </>
      }
    >
      {load.status === "loading" && (
        <p className="dialog-loading">
          <Spinner /> Loading…
        </p>
      )}
      {load.status === "error" && (
        <p className="field-error" role="alert">
          {load.message}
        </p>
      )}
      {mc && (
        <form id={`${nameId}-form`} className="form-grid" onSubmit={save} noValidate>
          <p className="dialog-text">
            Reached over SSH as <span className="mono">{mc.host}</span>.
          </p>
          <Field label="Display name" htmlFor={nameId}>
            <input id={nameId} className="input" type="text" value={name} placeholder={mc.name} autoComplete="off" disabled={saving} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="field">
            <span className="field-label">Folders on that machine</span>
            <PathRows values={folders} onChange={setFolders} problem={remoteFolderProblem} placeholder={FOLDER_PLACEHOLDER} disabled={saving} label="Folder on that machine" />
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}

/** Forget a machine: its section goes away and its SSH connection closes. */
export function RemoveMachineDialog({ id, name, onClose }: { id: string; name: string; onClose(): void }) {
  const { api, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.removeMachine(id);
      toast.info(`Removed ${name}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog open title={`Remove ${name}?`} confirmLabel="Remove" busy={busy} error={error} onConfirm={remove} onClose={onClose}>
      <p className="dialog-text">
        Portplane stops showing it and closes the SSH connection. Its dev servers keep running. The agent stays in{" "}
        <code>~/.cache/portplane</code> on that machine until you delete it.
      </p>
    </ConfirmDialog>
  );
}
