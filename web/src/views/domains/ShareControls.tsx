import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { ShareInfo, ShareKind } from "../../api/sharing";
import type { App, MachineSnapshot } from "../../api/types";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu } from "../../components/Menu";
import { ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { href } from "../../lib/router";
import { isPublic, SHARE_KINDS, SHARE_NAMES, shareState } from "../../lib/sharing";
import { ShareDialog } from "./ShareDialog";
import { useRefreshOnJobs } from "./store";
import "./Sharing.css";
// Its styles live with the Domains view, which may not have loaded (the app detail opens this too).
import "../DomainsView.css";

/** What each way is called in the Share menu: where the app becomes reachable. */
const MENU_LABELS: Record<ShareKind, string> = {
  tailscale: "On your tailnet",
  funnel: "Publicly, with Tailscale Funnel",
  ngrok: "Publicly, with ngrok",
  cloudflare: "Publicly, with Cloudflare",
};

/** "Share…" and its menu of ways. */
function ShareMenu({ kinds, disabled, title, onPick }: { kinds: ShareKind[]; disabled?: boolean; title?: string; onPick(kind: ShareKind): void }) {
  return (
    <Menu
      label="Share it"
      disabled={disabled}
      title={title}
      button={
        <>
          <Icon name="share" size={13} />
          Share…
          <Icon name="chevronDown" size={12} />
        </>
      }
      items={kinds.map((k) => ({ label: MENU_LABELS[k], icon: k === "tailscale" ? "lock" : "globe", onSelect: () => onPick(k) }))}
    />
  );
}

/**
 * One app's shares (plan §5.8), in one row: how it's shared now, and
 * "Share…" with the ways to share it. What a way still needs shows once
 * you pick it, in the ShareDialog, not as a warning on every way.
 */
export function ShareControls({ ms, app }: { ms: MachineSnapshot; app: App }) {
  const ctx = useApp();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ kind: ShareKind; on: boolean } | null>(null);
  const local = ms.machine.local;
  const load = () => {
    if (!local || !ms.tools.portless) return;
    setError(null);
    ctx.api.portlessShareInfo(ms.machine.id, app.id).then(setInfo, (err: unknown) => setError(errorText(err)));
  };
  useEffect(load, [ctx.api, ms.machine.id, app.id, local, !!ms.tools.portless]);
  useRefreshOnJobs(load);

  if (!local) return <p className="fact-note">Sharing apps on other machines works from that machine for now.</p>;
  if (!ms.tools.portless) return <p className="fact-note">Sharing goes through portless, which isn't installed here.</p>;
  if (error) return <ErrorState title="Couldn't read how this app is shared" message={error} onRetry={load} />;
  if (!info) return <LoadingState label="Checking sharing…" />;

  const states = SHARE_KINDS.map((kind) => shareState(info, kind));
  const on = states.filter((s) => s.on);
  const off = states.filter((s) => !s.on).map((s) => s.kind);

  return (
    <div className="share-controls">
      <ul className="share-rows">
        {on.map((s) => (
          <li key={s.kind} className="share-row is-on">
            <div className="share-row-main">
              <p className="share-row-state">
                <StateDot state={s.url ? "on" : info.running ? "starting" : "off"} />
                <span>
                  {SHARE_NAMES[s.kind]}
                  {isPublic(s.kind) && " · public"}
                </span>
                {s.url ? (
                  <>
                    <a className="addr" href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.url.replace(/^https?:\/\//, "")}
                    </a>
                    <IconButton icon="copy" label={`Copy ${s.url}`} onClick={() => void copyWithToast(ctx, s.url!, "the shared address")} />
                  </>
                ) : (
                  <span className="muted">{info.running ? "waiting for its address" : `shared when ${app.label} starts`}</span>
                )}
              </p>
              {s.viaEnv && <p className="fact-note">{s.why}</p>}
            </div>
            {!s.viaEnv && info.editable && (
              <button type="button" className="btn btn-sm" onClick={() => setOpen({ kind: s.kind, on: false })}>
                Stop sharing…
              </button>
            )}
          </li>
        ))}
        {off.length > 0 && (
          <li className="share-row">
            <p className="share-row-main muted">{on.length ? "Share it another way too" : "Not shared"}</p>
            <ShareMenu kinds={off} disabled={!info.editable} title={info.editable ? undefined : info.reason} onPick={(kind) => setOpen({ kind, on: true })} />
          </li>
        )}
      </ul>
      {!info.editable && info.reason && <p className="fact-note">{info.reason}</p>}
      <p className="share-foot">
        <a href={href({ view: "domains", section: "sharing" })}>Everything shared, and what each way needs</a>
      </p>
      {open && <ShareDialog target={{ machine: ms.machine.id, appId: app.id, label: app.label, runner: app.runner }} kind={open.kind} on={open.on} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The share controls in a dialog, for the routes table. */
export function ShareAppDialog({ ms, app, onClose }: { ms: MachineSnapshot; app: App; onClose(): void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Share ${app.label}`}
      size="md"
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <ShareControls ms={ms} app={app} />
    </Dialog>
  );
}
