import { useEffect, useState } from "react";
import { errorText } from "../../api/errors";
import type { ShareInfo, ShareKind } from "../../api/sharing";
import type { App, MachineSnapshot } from "../../api/types";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { href } from "../../lib/router";
import { readiness, SHARE_BLURBS, SHARE_KINDS, SHARE_TITLES, shareState } from "../../lib/sharing";
import { Requirements } from "./Requirements";
import { ShareDialog } from "./ShareDialog";
import { useRefreshOnJobs } from "./store";
import "./Sharing.css";
// Its styles live with the Domains view, which may not have loaded (the app detail opens this too).
import "../DomainsView.css";

/**
 * One app's shares (plan §5.8): on the tailnet, publicly through Funnel,
 * ngrok or Cloudflare. Each row says how it stands; turning one on or off
 * opens the ShareDialog.
 */
export function ShareControls({ ms, app, headingLevel = 3 }: { ms: MachineSnapshot; app: App; headingLevel?: 3 | 4 }) {
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

  const H = `h${headingLevel}` as const;
  if (!local) return <p className="fact-note">Sharing apps on other machines works from that machine for now.</p>;
  if (!ms.tools.portless) return <p className="fact-note">Sharing goes through portless, which isn't installed here.</p>;
  if (error) return <ErrorState title="Couldn't read how this app is shared" message={error} onRetry={load} />;
  if (!info) return <LoadingState label="Checking sharing…" />;

  return (
    <div className="share-controls">
      {!info.editable && info.reason && <p className="fact-note">{info.reason}</p>}
      <ul className="share-rows">
        {SHARE_KINDS.map((kind) => {
          const s = shareState(info, kind);
          const pub = kind !== "tailscale";
          return (
            <li key={kind} className={`share-row${s.on ? " is-on" : ""}`}>
              <div className="share-row-main">
                <H className="share-row-title">
                  {SHARE_TITLES[kind]}
                  {pub && <span className="tag tag-warn share-public-tag">public</span>}
                </H>
                <p className="share-row-desc">{SHARE_BLURBS[kind]}</p>
                {s.on && (
                  <p className="share-row-state">
                    <StateDot state={s.url ? "on" : info.running ? "starting" : "off"} />
                    {s.url ? (
                      <>
                        <a className="addr" href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.url.replace(/^https?:\/\//, "")}
                        </a>
                        <IconButton icon="copy" label={`Copy ${s.url}`} onClick={() => void copyWithToast(ctx, s.url!, "the shared address")} />
                      </>
                    ) : (
                      <span className="muted">{info.running ? "On; waiting for portless to report the address" : `On; shared when ${app.label} starts`}</span>
                    )}
                  </p>
                )}
                {s.viaEnv && <p className="fact-note">{s.why}</p>}
                {!s.on && info.editable && s.missing.length > 0 && (
                  <details className="share-missing">
                    <summary>
                      <Icon name="warning" size={13} />
                      {readiness(s.missing)}
                    </summary>
                    <Requirements reqs={s.missing} onChanged={load} />
                  </details>
                )}
              </div>
              <div className="share-row-action">
                {s.on && !s.viaEnv && info.editable && (
                  <button type="button" className="btn btn-sm" onClick={() => setOpen({ kind, on: false })}>
                    Stop sharing…
                  </button>
                )}
                {!s.on && (
                  <button type="button" className="btn btn-sm" disabled={!s.canToggle} title={s.canToggle ? undefined : s.why} onClick={() => setOpen({ kind, on: true })}>
                    <Icon name="share" size={13} />
                    Share…
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
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
