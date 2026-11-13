import { useMemo, useState } from "react";
import type { Requirement, ShareProvider, ShareView } from "../../api/sharing";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { appRoute, href } from "../../lib/router";
import { SHARE_NAMES, sortShares } from "../../lib/sharing";
import { useShell } from "../../shell/ShellContext";
import { Fold, Group } from "./Fold";
import { StatusGate } from "./ProxySection";
import { Requirements } from "./Requirements";
import { ShareDialog, type ShareTarget } from "./ShareDialog";
import { needsWord, ownNeeds } from "./shareStatus";
import { useSharing, valueOf } from "./store";
import "./Sharing.css";

function SharedNow({ shares }: { shares: ShareView[] }) {
  const ctx = useApp();
  const { snapshot } = useShell();
  const [stop, setStop] = useState<{ target: ShareTarget; kind: ShareView["kind"] } | null>(null);
  const local = snapshot?.machines.find((m) => m.machine.local);
  const sorted = useMemo(() => sortShares(shares), [shares]);
  const publicCount = shares.filter((s) => s.public && s.alive).length;

  return (
    <Group title="Shared now" description={publicCount > 0 ? `${publicCount} ${publicCount === 1 ? "address is" : "addresses are"} open to the internet. Stop what you don't need any more.` : undefined}>
      {sorted.length === 0 ? (
        <p className="sgroup-text">Nothing is shared. Share an app from its Address tab; shares started in a terminal show up here too.</p>
      ) : (
        <ul className="shares-list">
          {sorted.map((s) => {
            const app = s.owner?.kind === "app" && s.owner.appId ? local?.apps.find((a) => a.id === s.owner!.appId) : undefined;
            return (
              <li key={`${s.hostname}-${s.kind}`} className={`share-item${s.alive ? "" : " is-stale"}`}>
                <div className="share-item-main">
                  <p className="share-item-app">
                    {app && local ? <a href={href(appRoute(local.machine.id, app.id))}>{s.owner!.label}</a> : <span>{s.owner?.label ?? s.hostname}</span>}
                    <span className="muted mono"> {s.hostname}</span>
                  </p>
                  <p className="share-item-where">
                    <StateDot state={s.alive ? "on" : "failed"} />
                    <span>
                      {SHARE_NAMES[s.kind]}
                      {s.public && " · public"}
                      {!s.alive && " · not answering"}
                    </span>
                    <a className="addr" href={s.url} target="_blank" rel="noopener noreferrer">
                      {s.url.replace(/^https?:\/\//, "")}
                    </a>
                    <IconButton icon="copy" label={`Copy ${s.url}`} onClick={() => void copyWithToast(ctx, s.url, "the shared address")} />
                  </p>
                  {!(s.editable && app && local) && s.reason && <p className="share-item-reason">{s.reason}</p>}
                </div>
                {s.editable && app && local && (
                  <button type="button" className="btn btn-sm" onClick={() => setStop({ target: { machine: local.machine.id, appId: app.id, label: app.label, runner: app.runner }, kind: s.kind })}>
                    Stop sharing…
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {stop && <ShareDialog target={stop.target} kind={stop.kind} on={false} onClose={() => setStop(null)} />}
    </Group>
  );
}

/** One way to share, as one row: its name and how it stands; what it needs on expand. */
function Way({ p, own, sharedWith, reload }: { p: ShareProvider; own: Requirement[]; sharedWith?: string; reload(): void }) {
  return (
    <Fold
      className="way"
      summary={p.label}
      hint={
        <span className="inline-state">
          <StateDot state={p.ready ? "on" : "off"} />
          {needsWord(p.requirements)}
        </span>
      }
    >
      <p className="way-text">
        Addresses look like <span className="mono">{p.where}</span>
      </p>
      {p.notes.map((n) => (
        <p key={n} className="way-text">
          {n}
        </p>
      ))}
      {sharedWith && <p className="way-text">It also needs what {sharedWith} needs, above.</p>}
      {own.length > 0 && <Requirements reqs={own} showMet={false} onChanged={reload} />}
    </Fold>
  );
}

/** Everything shared, and what each way to share needs on this computer (plan §5.8). */
export function SharingSection() {
  const { state, reload } = useSharing();
  const ov = valueOf(state);
  return (
    <StatusGate>
      {() => {
        if (!ov) return state.status === "error" ? <ErrorState title="Couldn't read what's shared" message={state.error} onRetry={() => void reload()} /> : <LoadingState label="Checking Tailscale, ngrok and cloudflared…" />;
        const needs = ownNeeds(ov.providers);
        return (
          <>
            <SharedNow shares={ov.shares} />
            <Group
              title="Ways to share"
              description="Nothing is sent anywhere until you share an app."
              actions={
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void reload()} disabled={state.status === "loading"} aria-busy={state.status === "loading" || undefined}>
                  <Icon name="restart" size={13} />
                  Check again
                </button>
              }
            >
              {ov.providers.map((p) => {
                const n = needs.get(p.kind);
                return <Way key={p.kind} p={p} own={n?.own ?? []} sharedWith={n?.sharedWith} reload={() => void reload()} />;
              })}
            </Group>
          </>
        );
      }}
    </StatusGate>
  );
}
