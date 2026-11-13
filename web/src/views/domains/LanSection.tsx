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
import { ErrorState, LoadingState } from "../../components/States";
import { Menu } from "../../components/Menu";
import { appRoute, href } from "../../lib/router";
import { applyAction, lanAddressProblem, lanChoice, lanOptions, PHONE_TRUST, type LanChoice } from "../../lib/sharing";
import { Fact, Fold, Group, StatusLine } from "./Fold";
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

/** The address LAN mode publishes, in a few words, for the fold's summary. */
function choiceText(view: LanView, choice: LanChoice): string {
  const followed = view.addresses.find((a) => a.default) ?? view.addresses[0];
  if (choice.mode === "follow") return followed ? `follows this machine (${followed.ip} now)` : "follows this machine";
  return choice.ip || "another address";
}

function Mode({ view, status, checking, recheck }: { view: LanView; status: PortlessStatus; checking: boolean; recheck(): void }) {
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
  const choosing = view.ready && (!view.enabled || editing);

  const actions = view.enabled ? (
    editing ? null : (
      <>
        <button type="button" className="btn" onClick={() => show(action, lanOptions(view.options, false))}>
          {password && <Icon name="shield" size={13} />}
          Turn off…
        </button>
        {view.addresses.length > 0 && <Menu label="More LAN mode actions" items={[{ label: "Change the address…", icon: "pencil", onSelect: () => setEditing(true) }]} />}
      </>
    )
  ) : (
    <button type="button" className="btn" disabled={!view.ready || invalid} title={missing.length ? (missing[0].problem ?? missing[0].label) : undefined} onClick={turnOn}>
      {password && <Icon name="shield" size={13} />}
      Turn on…
    </button>
  );

  return (
    <Group
      title="LAN mode"
      description="Opens your apps from phones and other computers on the same Wi-Fi, at name.local."
      actions={
        <button type="button" className="btn btn-sm btn-ghost" onClick={recheck} disabled={checking} aria-busy={checking || undefined}>
          <Icon name="restart" size={13} />
          Check again
        </button>
      }
    >
      <StatusLine
        state={view.enabled ? (view.responding ? "on" : "failed") : "off"}
        sub={view.enabled ? "Anyone on the same network can open your apps. Turn it off on public or shared Wi-Fi." : "Turning it on moves every address to .local; running apps move when they restart."}
        actions={actions}
      >
        {view.enabled ? (view.responding ? `On at ${view.ip ?? "this machine's address"}` : "On, but the proxy isn't running") : "Off: your apps answer this machine only"}
      </StatusLine>
      {missing.length > 0 && <Requirements reqs={view.requirements} showMet={false} />}
      {choosing &&
        (editing ? (
          <div className="lan-edit">
            <AddressChoice view={view} choice={choice} onChange={setChoice} />
            <div className="sgroup-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={invalid} onClick={turnOn}>
                {password && <Icon name="shield" size={13} />}
                Apply the new address…
              </button>
            </div>
          </div>
        ) : (
          <Fold summary="Address phones use" hint={choiceText(view, choice)}>
            <AddressChoice view={view} choice={choice} onChange={setChoice} />
          </Fold>
        ))}
      <Fold summary="Details">
        <dl className="dfacts">
          <Fact label="Publishes names with">{view.mdns.tool ?? "nothing: this system can't publish .local names"}</Fact>
          <Fact label="Startup service">{view.serviceInstalled ? "Turning it on or off reinstalls it, which asks for your password" : "Not installed: LAN mode lasts until the proxy restarts"}</Fact>
        </dl>
      </Fold>
      {dialog}
    </Group>
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
        <p className="muted qr-hint">Point the phone's camera at the code. The phone needs the same Wi-Fi and portless's certificate (see Open on a phone).</p>
      </div>
    </Dialog>
  );
}

function Addresses({ view }: { view: LanView }) {
  const ctx = useApp();
  const [qr, setQr] = useState<LanApp | null>(null);
  const pending = view.enabled ? view.apps.filter((a) => a.route !== a.hostname).length : 0;
  return (
    <>
      {pending > 0 && (
        <p className="rename-note">
          <Icon name="info" size={13} />
          {pending === 1 ? "1 app still answers at its old address" : `${pending} apps still answer at their old addresses`}: restart {pending === 1 ? "it" : "them"} to move to .local.
        </p>
      )}
      {view.apps.length === 0 ? (
        <p className="sgroup-text">No running apps. An app that runs through portless shows up here with its .local address.</p>
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
                {view.enabled && a.route !== a.hostname && <span className="muted lan-app-route">now at {a.route}</span>}
              </div>
              <span className="table-actions">
                <IconButton icon="copy" label={`Copy ${a.url}`} onClick={() => void copyWithToast(ctx, a.url, "the URL")} />
                {view.enabled && <IconButton icon="qr" label={`Show a QR code for ${a.hostname}`} onClick={() => setQr(a)} />}
              </span>
            </li>
          ))}
        </ul>
      )}
      {qr && <QrDialog app={qr} onClose={() => setQr(null)} />}
    </>
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
    <div className="sgroup">
      <div className="sgroup-body">
        <p className="sgroup-text">The phone needs to trust portless's certificate once. Nothing goes through the internet.</p>
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
                    <Fold summary="Fingerprint to compare">
                      <p className="phone-step-text muted">
                        The phone shows it (SHA-256) when you install the file: <span className="mono phone-fingerprint">{fingerprint}</span>
                      </p>
                    </Fold>
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
      </div>
    </div>
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
        // Off, the apps' .local names and the phone's steps wait folded: they matter once the mode is on.
        const on = view.enabled;
        return (
          <>
            <Mode view={view} status={status} checking={state.status === "loading"} recheck={() => void reload()} />
            {view.mdns.supported &&
              (on ? (
                <Group title="Your apps on the network" description="Each name is published while its app runs.">
                  <Addresses view={view} />
                </Group>
              ) : (
                <div className="dfolds">
                  <Fold className="dfold-section" summary="Where your apps would be" hint={`${view.apps.length} running`}>
                    <div className="sgroup">
                      <div className="sgroup-body">
                        <Addresses view={view} />
                      </div>
                    </div>
                  </Fold>
                </div>
              ))}
            {view.mdns.supported && view.https && (
              <div id="lan-phone" className={on ? "lan-phone-wrap" : "lan-phone-wrap is-folded"}>
                <Fold className="dfold-section" summary="Open on a phone" hint="Trust the certificate, then scan a code" open={on || phoneFirst || undefined}>
                  <Phone view={view} />
                </Fold>
              </div>
            )}
          </>
        );
      }}
    </StatusGate>
  );
}
