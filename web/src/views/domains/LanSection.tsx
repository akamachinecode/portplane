import { useEffect, useId, useState } from "react";
import { errorText } from "../../api/errors";
import type { PortlessStatus } from "../../api/portless";
import type { LanApp, LanView } from "../../api/sharing";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { Dialog } from "../../components/Dialog";
import { Icon, Spinner } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Segmented } from "../../components/Segmented";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { appRoute, href } from "../../lib/router";
import { applyAction, lanAddressProblem, lanChoice, lanOptions, PHONE_TRUST, type LanChoice } from "../../lib/sharing";
import { SettingRow, SettingsGroup } from "../settings/SettingsGroup";
import { StatusGate, usePlan } from "./ProxySection";
import { QrCode } from "./QrCode";
import { Requirements } from "./Requirements";
import { useIntent, useLan, valueOf } from "./store";
import "./Sharing.css";

/** Which address LAN mode publishes: the one this computer has now (followed), one of its addresses, or one typed in. */
function AddressChoice({ view, choice, onChange }: { view: LanView; choice: LanChoice; onChange(next: LanChoice): void }) {
  const name = useId();
  const customId = useId();
  const followed = view.addresses.find((a) => a.default) ?? view.addresses[0];
  const problem = choice.mode === "custom" ? lanAddressProblem(choice.ip) : null;
  return (
    <fieldset className="lan-choice">
      <legend className="field-label">Address phones use</legend>
      <label className="lan-option">
        <input type="radio" name={name} checked={choice.mode === "follow"} onChange={() => onChange({ mode: "follow" })} />
        <span>
          <span className="lan-option-title">Follow this machine's address</span>
          <span className="lan-option-desc">{followed ? `${followed.ip} on ${followed.interface} now; portless follows it when you change networks.` : "portless picks the address of your current network."}</span>
        </span>
      </label>
      {view.addresses.map((a) => (
        <label key={a.ip} className="lan-option">
          <input type="radio" name={name} checked={choice.mode === "pin" && choice.ip === a.ip} onChange={() => onChange({ mode: "pin", ip: a.ip })} />
          <span>
            <span className="lan-option-title mono">{a.ip}</span>
            <span className="lan-option-desc">
              Always {a.interface}
              {a.default ? " (the one in use now)" : ""}
            </span>
          </span>
        </label>
      ))}
      <label className="lan-option">
        <input type="radio" name={name} checked={choice.mode === "custom"} onChange={() => onChange({ mode: "custom", ip: choice.mode === "custom" ? choice.ip : "" })} />
        <span>
          <span className="lan-option-title">Another address</span>
          <span className="lan-option-desc">For a network Portplane can't see from here.</span>
        </span>
      </label>
      {choice.mode === "custom" && (
        <div className="lan-custom">
          <label className="sr-only" htmlFor={customId}>
            IP address
          </label>
          <input
            id={customId}
            className="input mono"
            value={choice.ip}
            placeholder="192.168.1.20"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            onChange={(e) => onChange({ mode: "custom", ip: e.target.value })}
          />
          {problem && choice.ip.trim() && (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

function Mode({ view, status }: { view: LanView; status: PortlessStatus }) {
  const { show, dialog } = usePlan();
  const [choice, setChoice] = useState<LanChoice>(() => lanChoice(view));
  const [editing, setEditing] = useState(false);
  useEffect(() => setChoice(lanChoice(view)), [view.enabled, view.options.lanIp]);
  const action = applyAction(view.serviceInstalled, view.responding);
  const invalid = choice.mode === "custom" && !!lanAddressProblem(choice.ip);
  const ip = choice.mode === "follow" ? undefined : choice.ip;
  const turnOn = () => show(action, lanOptions(view.options, true, ip));
  const password = view.serviceInstalled || status.adminToStart;
  const missing = view.requirements.filter((r) => !r.ok);

  return (
    <SettingsGroup
      title="LAN mode"
      description="Opens your apps from phones, tablets and other computers on the same Wi-Fi. portless publishes each app as name.local over mDNS (Bonjour), and the proxy answers on your network address as well as on this machine."
    >
      <SettingRow label="State">
        <span className="inline-state">
          <StateDot state={view.enabled ? (view.responding ? "on" : "failed") : "off"} />
          {view.enabled ? (view.responding ? `On at ${view.ip ?? "this machine's address"}` : "On, but the proxy isn't running") : "Off: your apps answer this machine only"}
        </span>
      </SettingRow>
      <Requirements reqs={view.requirements} />
      {view.enabled && !editing ? (
        <>
          <p className="rename-note rename-warn">
            <Icon name="warning" size={13} />
            Anyone on the same network can open your apps while LAN mode is on. Turn it off on public or shared Wi-Fi.
          </p>
          <div className="sgroup-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)} disabled={!view.addresses.length}>
              Change the address…
            </button>
            <button type="button" className="btn" onClick={() => show(action, lanOptions(view.options, false))}>
              {password && <Icon name="shield" size={13} />}
              Turn off LAN mode…
            </button>
          </div>
        </>
      ) : (
        <>
          {view.ready && <AddressChoice view={view} choice={choice} onChange={setChoice} />}
          <p className="rename-note">
            <Icon name="info" size={13} />
            {view.serviceInstalled
              ? "portless keeps this in its startup service, so Portplane reinstalls the service with --lan. That asks for your password."
              : "Portplane restarts the proxy with --lan. Install the startup service in Proxy to keep it across restarts."}{" "}
            Every address moves to .local, and running apps get theirs when they restart.
          </p>
          <div className="sgroup-foot">
            {editing && (
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            <button type="button" className="btn btn-primary" disabled={!view.ready || invalid} title={missing.length ? (missing[0].problem ?? missing[0].label) : undefined} onClick={turnOn}>
              {password && <Icon name="shield" size={13} />}
              {view.enabled ? "Apply the new address…" : "Turn on LAN mode…"}
            </button>
          </div>
        </>
      )}
      {dialog}
    </SettingsGroup>
  );
}

/** The QR code a phone scans to open one app. */
function QrDialog({ app, onClose }: { app: LanApp; onClose(): void }) {
  const ctx = useApp();
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Open ${app.label} on a phone`}
      size="sm"
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="qr-card">
        <QrCode value={app.url} label={`QR code for ${app.url}`} />
        <p className="qr-url">
          <span className="mono">{app.url}</span>
          <IconButton icon="copy" label={`Copy ${app.url}`} onClick={() => void copyWithToast(ctx, app.url, "the URL")} />
        </p>
        <p className="muted qr-hint">Point the phone's camera at the code. The phone has to be on the same Wi-Fi as this machine and trust portless's certificate (Domains → LAN mode → Open on a phone).</p>
      </div>
    </Dialog>
  );
}

function Addresses({ view }: { view: LanView }) {
  const ctx = useApp();
  const [qr, setQr] = useState<LanApp | null>(null);
  const pending = view.enabled ? view.apps.filter((a) => a.route !== a.hostname).length : 0;
  return (
    <SettingsGroup
      title={view.enabled ? "Your apps on the network" : "Where your apps would be"}
      description={
        view.enabled
          ? "Open these from any device on the same Wi-Fi. Each name is published while its app runs."
          : "With LAN mode on, each running app answers at its name under .local. Nothing is published now."
      }
    >
      {pending > 0 && (
        <p className="rename-note">
          <Icon name="info" size={13} />
          {pending === 1 ? "1 app still answers at its old address" : `${pending} apps still answer at their old addresses`}: restart {pending === 1 ? "it" : "them"} to move to .local.
        </p>
      )}
      {view.apps.length === 0 ? (
        <EmptyState icon="wifi" title="No running apps">
          Start an app that runs through portless and it shows up here with its .local address.
        </EmptyState>
      ) : (
        <ul className="lan-apps">
          {view.apps.map((a) => (
            <li key={a.hostname} className="lan-app">
              <div className="lan-app-main">
                {a.appId && a.machine ? (
                  <a className="lan-app-label" href={href(appRoute(a.machine, a.appId))}>
                    {a.label}
                  </a>
                ) : (
                  <span className="lan-app-label">{a.label}</span>
                )}
                {view.enabled && view.responding ? (
                  <a className="addr" href={a.url} target="_blank" rel="noopener noreferrer">
                    {a.hostname}
                  </a>
                ) : (
                  <span className="addr addr-idle">{a.hostname}</span>
                )}
                {view.enabled && a.route !== a.hostname && <span className="muted lan-app-route">now {a.route}: restart it to move</span>}
              </div>
              <span className="table-actions">
                <IconButton icon="copy" label={`Copy ${a.url}`} onClick={() => void copyWithToast(ctx, a.url, "the URL")} />
                <IconButton icon="qr" label={`Show a QR code for ${a.hostname}`} disabled={!view.enabled} onClick={() => setQr(a)} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {qr && <QrDialog app={qr} onClose={() => setQr(null)} />}
    </SettingsGroup>
  );
}

/** Getting a phone to trust portless's certificate, then opening an app on it. */
function Phone({ view }: { view: LanView }) {
  const ctx = useApp();
  const [os, setOs] = useState<"ios" | "android">("ios");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [pick, setPick] = useState(view.apps[0]?.hostname ?? "");
  const pickId = useId();
  const app = view.apps.find((a) => a.hostname === pick) ?? view.apps[0];
  const trust = PHONE_TRUST[os];
  const fingerprint = view.ca.fingerprint;

  const exportCA = async () => {
    setExporting(true);
    try {
      const res = await ctx.api.portlessExportCA();
      setExported(res.path);
      ctx.toast.info(res.revealed ? `Saved ${res.path} and opened its folder` : `Saved ${res.path}`);
    } catch (err) {
      ctx.toast.error(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <SettingsGroup
      title="Open on a phone"
      description="A phone opens your apps over HTTPS once it trusts portless's local certificate, the same one this machine trusts. Nothing here goes through the internet: the file stays on your computer until you move it, and the QR code holds only the app's .local address."
    >
      <div className="phone">
        <ol className="phone-steps">
          <li>
            <h3 className="phone-step-title">Export the certificate</h3>
            {view.ca.exists ? (
              <>
                <p className="phone-step-text">Saves ca.pem, the certificate without its private key, to your Downloads folder.</p>
                <div className="phone-step-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void exportCA()} disabled={exporting} aria-busy={exporting || undefined}>
                    {exporting ? <Spinner /> : <Icon name="download" size={13} />}
                    Export ca.pem
                  </button>
                </div>
                {exported && (
                  <p className="phone-step-text">
                    Saved to <span className="mono path-value">{exported}</span>
                  </p>
                )}
                {fingerprint && (
                  <p className="phone-step-text muted">
                    The phone shows this fingerprint (SHA-256) when you install it: <span className="mono phone-fingerprint">{fingerprint}</span>
                  </p>
                )}
              </>
            ) : (
              <p className="phone-step-text">portless hasn't created its certificate yet. It does when the proxy first starts with HTTPS.</p>
            )}
          </li>
          <li>
            <h3 className="phone-step-title">Install and trust it on the phone</h3>
            <Segmented<"ios" | "android">
              label="Phone"
              value={os}
              onChange={setOs}
              options={[
                { value: "ios", label: "iPhone, iPad" },
                { value: "android", label: "Android" },
              ]}
            />
            <ol className="phone-trust" aria-label={`Steps for ${trust.title}`}>
              {trust.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </li>
          <li>
            <h3 className="phone-step-title">Scan an app's code</h3>
            <p className="phone-step-text">{view.enabled ? "Connect the phone to the same Wi-Fi, then point its camera at the code." : "Turn on LAN mode first: until then, the phone can't reach your apps."}</p>
          </li>
        </ol>
        <div className="phone-qr">
          {app ? (
            <>
              <label className="field-label" htmlFor={pickId}>
                App
              </label>
              <select id={pickId} className="input" value={app.hostname} onChange={(e) => setPick(e.target.value)}>
                {view.apps.map((a) => (
                  <option key={a.hostname} value={a.hostname}>
                    {a.label} · {a.hostname}
                  </option>
                ))}
              </select>
              <div className={`qr-card${view.enabled ? "" : " is-off"}`}>
                <QrCode value={app.url} label={`QR code for ${app.url}`} size={176} />
                <p className="qr-url mono">{app.url}</p>
              </div>
            </>
          ) : (
            <p className="muted">Start an app to get its code here.</p>
          )}
        </div>
      </div>
    </SettingsGroup>
  );
}

/** LAN mode (plan §5.1, §5.6): its needs, the switch, every app's .local address, and a phone's certificate. */
export function LanSection() {
  const { state, reload } = useLan();
  const view = valueOf(state);
  const [phoneFirst, setPhoneFirst] = useState(false);
  useIntent("lan-phone", () => setPhoneFirst(true));
  useEffect(() => {
    if (phoneFirst && view) document.getElementById("lan-phone")?.scrollIntoView({ block: "start" });
  }, [phoneFirst, !!view]);
  return (
    <StatusGate>
      {(status) => {
        if (!view) return state.status === "error" ? <ErrorState title="Couldn't read LAN mode" message={state.error} onRetry={() => void reload()} /> : <LoadingState label="Checking this machine's network…" />;
        return (
          <>
            <div className="section-bar">
              <p className="section-bar-text">{view.mdns.tool ? `portless publishes names with ${view.mdns.tool}.` : "portless can't publish .local names on this system."}</p>
              <span className="spacer" />
              <button type="button" className="btn btn-sm" onClick={() => void reload()} disabled={state.status === "loading"} aria-busy={state.status === "loading" || undefined}>
                <Icon name="restart" size={13} />
                Check again
              </button>
            </div>
            <Mode view={view} status={status} />
            {view.mdns.supported && <Addresses view={view} />}
            {view.mdns.supported && view.https && (
              <div id="lan-phone" className="lan-phone-wrap">
                <Phone view={view} />
              </div>
            )}
          </>
        );
      }}
    </StatusGate>
  );
}
