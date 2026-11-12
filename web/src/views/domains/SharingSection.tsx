import { useMemo, useState } from "react";
import type { ShareProvider, ShareView } from "../../api/sharing";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { appRoute, href } from "../../lib/router";
import { readiness, SHARE_NAMES, sortShares } from "../../lib/sharing";
import { useShell } from "../../shell/ShellContext";
import { SettingsGroup } from "../settings/SettingsGroup";
import { StatusGate } from "./ProxySection";
import { Requirements } from "./Requirements";
import { ShareDialog, type ShareTarget } from "./ShareDialog";
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
    <SettingsGroup
      title="Shared now"
      description={
        publicCount > 0 ? (
          <span className="warn-text">
            {publicCount} {publicCount === 1 ? "address is" : "addresses are"} open to the internet. Stop what you don't need any more.
          </span>
        ) : (
          "Every address portless reports for your apps, on your tailnet or on the internet."
        )
      }
    >
      {sorted.length === 0 ? (
        <EmptyState icon="share" title="Nothing is shared">
          Open an app, then its URL tab, to share it on your tailnet or publicly. Shares you start with <code>portless &lt;name&gt; --tailscale</code> in a terminal show up here too.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table shares-table">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Shared with</th>
                <th scope="col">Address</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => {
                const app = s.owner?.kind === "app" && s.owner.appId ? local?.apps.find((a) => a.id === s.owner!.appId) : undefined;
                return (
                  <tr key={`${s.hostname}-${s.kind}`} className={s.alive ? undefined : "is-stale"}>
                    <td>
                      {app && local ? <a href={href(appRoute(local.machine.id, app.id))}>{s.owner!.label}</a> : <span>{s.owner?.label ?? s.hostname}</span>}
                      <span className="muted mono share-host"> {s.hostname}</span>
                    </td>
                    <td>
                      <span className="inline-state">
                        <StateDot state={s.alive ? "on" : "failed"} />
                        {SHARE_NAMES[s.kind]}
                      </span>
                      {s.public && <span className="tag tag-warn share-public-tag">public</span>}
                    </td>
                    <td>
                      <span className="share-url-cell">
                        <a className="addr" href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.url.replace(/^https?:\/\//, "")}
                        </a>
                        <IconButton icon="copy" label={`Copy ${s.url}`} onClick={() => void copyWithToast(ctx, s.url, "the shared address")} />
                      </span>
                    </td>
                    <td className="row-actions-cell">
                      {s.editable && app && local ? (
                        <button type="button" className="btn btn-sm" onClick={() => setStop({ target: { machine: local.machine.id, appId: app.id, label: app.label, runner: app.runner }, kind: s.kind })}>
                          Stop sharing…
                        </button>
                      ) : (
                        <span className="muted share-reason">{s.reason}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {stop && <ShareDialog target={stop.target} kind={stop.kind} on={false} onClose={() => setStop(null)} />}
    </SettingsGroup>
  );
}

function Provider({ p, reload }: { p: ShareProvider; reload(): void }) {
  return (
    <section className={`provider${p.ready ? " is-ready" : ""}`} aria-labelledby={`provider-${p.kind}`}>
      <header className="provider-head">
        <h3 className="provider-title" id={`provider-${p.kind}`}>
          {p.label}
        </h3>
        {p.public ? <span className="tag tag-warn">public</span> : <span className="tag">private</span>}
        <span className="spacer" />
        <span className="inline-state provider-state">
          <StateDot state={p.ready ? "on" : "off"} />
          {readiness(p.requirements)}
        </span>
      </header>
      <p className="provider-where">
        Addresses look like <span className="mono">{p.where}</span>
      </p>
      {p.notes.map((n) => (
        <p key={n} className="provider-note">
          {n}
        </p>
      ))}
      {!p.ready && <Requirements reqs={p.requirements} onChanged={reload} />}
    </section>
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
        return (
          <>
            <SharedNow shares={ov.shares} />
            <SettingsGroup
              title="Ways to share"
              description="portless shares an app through one of these when its command carries the flag. Portplane checks what each needs here; nothing is sent anywhere until you share an app."
            >
              <div className="section-bar">
                <span className="spacer" />
                <button type="button" className="btn btn-sm" onClick={() => void reload()} disabled={state.status === "loading"} aria-busy={state.status === "loading" || undefined}>
                  <Icon name="restart" size={13} />
                  Check again
                </button>
              </div>
              <div className="providers">
                {ov.providers.map((p) => (
                  <Provider key={p.kind} p={p} reload={() => void reload()} />
                ))}
              </div>
            </SettingsGroup>
          </>
        );
      }}
    </StatusGate>
  );
}
