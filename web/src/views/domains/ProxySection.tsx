import { useEffect, useId, useState, type ReactNode } from "react";
import type { PortlessAction, PortlessStatus, ProxyOptions } from "../../api/portless";
import { Field, Switch } from "../../components/Controls";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { StateDot } from "../../components/StateDot";
import { cleanTlds, describeOptions, lowPort, normalizeOptions, optionsProblems, proxyUrl, sameOptions, tldProblem, tldWarning } from "../../lib/portless";
import { SettingRow, SettingsGroup } from "../settings/SettingsGroup";
import { PlanDialog } from "./PlanDialog";
import { usePortlessStatus, valueOf } from "./store";

/** Guards a section on portless's status: loading, error, not installed. */
export function StatusGate({ children }: { children: (status: PortlessStatus) => ReactNode }) {
  const { state, reload } = usePortlessStatus();
  const status = valueOf(state);
  if (status) {
    if (!status.installed) return <NotInstalled />;
    return <>{children(status)}</>;
  }
  if (state.status === "error") return <ErrorState title="Couldn't read portless's state" message={state.error} onRetry={() => void reload()} />;
  return <LoadingState label="Reading portless…" />;
}

export function NotInstalled() {
  return (
    <EmptyState
      icon="globe"
      title="portless isn't installed"
      action={
        <a className="btn" href="#/settings/tools">
          <Icon name="wand" size={14} />
          Open Tools
        </a>
      }
    >
      portless gives every dev server a stable https://name.localhost address. Install it from Settings → Tools or the welcome screen, then manage it here.
    </EmptyState>
  );
}

/** Opens a plan for an action, from anywhere in a section. */
export function usePlan() {
  const [open, setOpen] = useState<{ action: PortlessAction; options?: ProxyOptions } | null>(null);
  const dialog = open && <PlanDialog action={open.action} options={open.options} onClose={() => setOpen(null)} />;
  return { show: (action: PortlessAction, options?: ProxyOptions) => setOpen({ action, options }), dialog };
}

function ProxyState({ status, plan }: { status: PortlessStatus; plan: (a: PortlessAction) => void }) {
  const p = status.proxy;
  const example = proxyUrl(`web.${p.tlds[0] ?? "localhost"}`, p);
  return (
    <SettingsGroup title="Proxy" description="The local server that answers every .localhost address and passes each request to the right app.">
      <SettingRow label="State">
        <span className="inline-state">
          <StateDot state={p.responding ? "on" : "failed"} />
          {p.responding ? `Running on port ${p.port} with ${p.https ? "HTTPS" : "HTTP"}` : "Not running: your .localhost addresses won't load"}
        </span>
      </SettingRow>
      {p.responding && (
        <SettingRow label="Addresses" description="Every app gets one under each domain; the first is the main one.">
          <span className="chips">
            {p.tlds.map((t, i) => (
              <span key={t} className={`chip mono${i === 0 ? " chip-main" : ""}`}>
                .{t}
              </span>
            ))}
            <span className="muted mono">{example}</span>
          </span>
        </SettingRow>
      )}
      {(p.lan || p.unprivileged || p.customCert || status.options.wildcard) && (
        <SettingRow label="Modes">
          <span className="chips">
            {p.lan && <span className="chip">LAN{p.lanIp ? ` · ${p.lanIp}` : ""}</span>}
            {p.unprivileged && <span className="chip">Unprivileged</span>}
            {p.customCert && <span className="chip">Own certificate</span>}
            {status.options.wildcard && <span className="chip">Wildcard subdomains</span>}
          </span>
        </SettingRow>
      )}
      {p.pid !== undefined && p.responding && (
        <SettingRow label="Process">
          <span className="mono">
            PID {p.pid}
            {p.asRoot && <span className="muted"> · runs as administrator</span>}
          </span>
        </SettingRow>
      )}
      <div className="sgroup-foot">
        {p.responding ? (
          <>
            <button type="button" className="btn" onClick={() => plan("proxy-restart")}>
              <Icon name="restart" size={14} />
              Restart
            </button>
            <button type="button" className="btn" onClick={() => plan("proxy-stop")}>
              <Icon name={status.adminToStop ? "shield" : "stop"} size={13} />
              Stop
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => plan("proxy-start")}>
            <Icon name={status.adminToStart ? "shield" : "play"} size={13} />
            Start the proxy
          </button>
        )}
      </div>
    </SettingsGroup>
  );
}

function Service({ status, plan }: { status: PortlessStatus; plan: (a: PortlessAction) => void }) {
  const s = status.service;
  const prog = status.program;
  const missing = prog && (prog.nodeMissing || prog.scriptMissing);
  return (
    <SettingsGroup title="Startup service" description="A system service that starts the proxy whenever the computer starts. Installing, changing or removing it asks for your password.">
      {!s && <p className="muted">{status.serviceError ? `Couldn't ask portless about its service: ${status.serviceError}` : "Unknown."}</p>}
      {s && (
        <>
          <SettingRow label="Installed">
            <span className="inline-state">
              <StateDot state={s.installed ? (missing ? "failed" : "on") : "off"} />
              {s.installed ? `Yes · ${s.managerState}` : "No: the proxy runs only until you stop it or restart"}
            </span>
          </SettingRow>
          {s.installed && prog && (
            <SettingRow label="Node.js" description={missing ? "The service starts a program that no longer exists, as after a Node.js or portless upgrade. Reinstall it to point it at the ones you have now." : "The Node.js the service starts portless with."}>
              <span className={`mono path-value${prog.nodeMissing ? " is-missing" : ""}`}>
                {prog.node}
                {prog.nodeMissing && <span className="tag tag-warn">missing</span>}
              </span>
            </SettingRow>
          )}
          {s.installed && prog?.scriptMissing && (
            <SettingRow label="portless">
              <span className="mono path-value is-missing">
                {prog.script}
                <span className="tag tag-warn">missing</span>
              </span>
            </SettingRow>
          )}
          {s.installed && s.entry && (
            <SettingRow label="Service file">
              <span className="mono path-value">{s.entry}</span>
            </SettingRow>
          )}
        </>
      )}
      <div className="sgroup-foot">
        {s?.installed ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => plan("service-uninstall")}>
              <Icon name="trash" size={13} />
              Remove
            </button>
            <button type="button" className={`btn${missing ? " btn-primary" : ""}`} onClick={() => plan("service-install")}>
              <Icon name="shield" size={13} />
              Reinstall
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => plan("service-install")}>
            <Icon name="shield" size={13} />
            Install the service
          </button>
        )}
      </div>
    </SettingsGroup>
  );
}

function Domains({ tlds, onChange, disabled, error }: { tlds: string[]; onChange(next: string[]): void; disabled: boolean; error?: string }) {
  const [draft, setDraft] = useState("");
  const id = useId();
  const draftProblem = draft.trim() ? tldProblem(draft) : null;
  const add = () => {
    if (!draft.trim() || draftProblem) return;
    onChange(cleanTlds([...tlds, draft]));
    setDraft("");
  };
  return (
    <div className="field">
      <span className="field-label" id={`${id}-l`}>
        Domains
      </span>
      <ol className="tld-list" aria-labelledby={`${id}-l`}>
        {tlds.map((t, i) => {
          const warn = tldWarning(t);
          return (
            <li key={t} className="tld-row">
              <span className="tld-name mono">.{t}</span>
              {i === 0 && <span className="tag">main</span>}
              <span className="spacer" />
              {i > 0 && (
                <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => onChange([t, ...tlds.filter((x) => x !== t)])} aria-label={`Make .${t} the main domain`}>
                  Make main
                </button>
              )}
              <IconButton icon="close" label={`Remove .${t}`} disabled={disabled || tlds.length === 1} onClick={() => onChange(tlds.filter((x) => x !== t))} />
              {warn && (
                <p className="tld-warn" role="note">
                  <Icon name="warning" size={13} />
                  {warn}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <div className="tld-add">
        <input
          className="input mono"
          value={draft}
          placeholder="test"
          aria-label="Add a domain"
          aria-invalid={draftProblem ? true : undefined}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn" onClick={add} disabled={disabled || !draft.trim() || !!draftProblem}>
          <Icon name="plus" size={13} />
          Add
        </button>
      </div>
      {(draftProblem || error) && (
        <p className="field-error" role="alert">
          {draftProblem ?? error}
        </p>
      )}
      {!draftProblem && !error && draft.trim() && tldWarning(draft) && <p className="field-hint">{tldWarning(draft)}</p>}
      {!draft.trim() && <p className="field-hint">Names other than .localhost need entries in the hosts file, which portless writes for you.</p>}
    </div>
  );
}

function Options({ status, plan }: { status: PortlessStatus; plan: (a: PortlessAction, o?: ProxyOptions) => void }) {
  const current = status.options;
  const [o, setO] = useState<ProxyOptions>(() => ({ ...current, tlds: cleanTlds(current.tlds) }));
  useEffect(() => setO({ ...current, tlds: cleanTlds(current.tlds) }), [JSON.stringify(current)]);
  const set = (patch: Partial<ProxyOptions>) => setO((prev) => ({ ...prev, ...patch }));
  const problems = optionsProblems(o);
  const invalid = Object.keys(problems).length > 0;
  const changed = !sameOptions(o, current);
  const ids = { port: useId(), ip: useId(), cert: useId(), key: useId() };
  const service = status.service?.installed;
  const preview = proxyUrl(`web.${o.lan ? "local" : (cleanTlds(o.tlds)[0] ?? "localhost")}`, { port: o.port, https: o.https });

  return (
    <SettingsGroup
      title="Options"
      description={
        service
          ? "portless keeps these options in its startup service, so applying them reinstalls the service. That asks for your password."
          : "These apply the next time the proxy starts. Install the service to keep them across restarts."
      }
    >
      <div className="form-grid proxy-form">
        <Field label="Port" htmlFor={ids.port} error={problems.port} hint={lowPort(o.port) ? "Ports below 1024 need your password once on Linux; macOS and Windows allow them." : "A port of 1024 or more needs no password, but every URL carries it."}>
          <div className="port-choice">
            <input id={ids.port} className="input mono port-input" type="number" min={1} max={65535} value={Number.isFinite(o.port) ? o.port : ""} onChange={(e) => set({ port: e.target.valueAsNumber })} aria-invalid={problems.port ? true : undefined} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ port: o.https ? 443 : 80 })}>
              Standard ({o.https ? 443 : 80})
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ port: 1355 })}>
              No password (1355)
            </button>
          </div>
        </Field>
        <Switch checked={o.https} onChange={(https) => set({ https, port: o.port === 443 && !https ? 80 : o.port === 80 && https ? 443 : o.port })} label="HTTPS" description="Serves every address over HTTPS with portless's local certificate, which your system has to trust once." />
        {!o.lan && <Domains tlds={cleanTlds(o.tlds)} onChange={(tlds) => set({ tlds })} disabled={false} error={problems.tlds} />}
        <Switch checked={o.wildcard} onChange={(wildcard) => set({ wildcard })} label="Wildcard subdomains" description="An address no app registered falls back to its closest parent: feature.web.localhost opens web.localhost." />
        <Switch checked={o.lan} onChange={(lan) => set({ lan, lanIp: lan ? o.lanIp : undefined })} label="Share on your network (LAN)" description="Publishes every app as name.local over mDNS, so phones and other computers on your Wi-Fi can open it. Domains switch to .local." />
        {o.lan && (
          <Field label="LAN address" htmlFor={ids.ip} error={problems.lanIp} hint="Leave it empty to follow this computer's address as it changes.">
            <input id={ids.ip} className="input mono" value={o.lanIp ?? ""} placeholder="192.168.1.20" onChange={(e) => set({ lanIp: e.target.value })} aria-invalid={problems.lanIp ? true : undefined} />
          </Field>
        )}
        <Switch checked={o.unprivileged} onChange={(unprivileged) => set({ unprivileged })} label="Unprivileged" description="Takes a port below 1024 without your password where the system allows it, accepting connections from this computer only. Never writes the hosts file." />
        <details className="proxy-cert" open={!!(o.certPath || o.keyPath)}>
          <summary>Your own certificate</summary>
          <p className="field-hint">Instead of portless's local certificate authority, serve a certificate you already have (from mkcert or your company, say).</p>
          <Field label="Certificate file" htmlFor={ids.cert} error={problems.certPath}>
            <input id={ids.cert} className="input mono" value={o.certPath ?? ""} placeholder="/home/dev/certs/dev.pem" onChange={(e) => set({ certPath: e.target.value })} />
          </Field>
          <Field label="Key file" htmlFor={ids.key} error={problems.keyPath}>
            <input id={ids.key} className="input mono" value={o.keyPath ?? ""} placeholder="/home/dev/certs/dev-key.pem" onChange={(e) => set({ keyPath: e.target.value })} />
          </Field>
        </details>
        <p className="proxy-preview">
          Apps will be at <span className="mono">{preview}</span>
        </p>
      </div>
      <div className="sgroup-foot">
        {changed && (
          <button type="button" className="btn btn-ghost" onClick={() => setO({ ...current, tlds: cleanTlds(current.tlds) })}>
            Reset
          </button>
        )}
        {!service && (
          <button type="button" className="btn" disabled={invalid || !changed} onClick={() => plan(status.proxy.responding ? "proxy-restart" : "proxy-start", normalizeOptions(o))}>
            {status.proxy.responding ? "Restart with these options" : "Start with these options"}
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={invalid || (!changed && !!service)} onClick={() => plan("service-install", normalizeOptions(o))} title={describeOptions(normalizeOptions(o))}>
          <Icon name="shield" size={13} />
          {service ? "Apply: reinstall the service" : "Install the service with these options"}
        </button>
      </div>
    </SettingsGroup>
  );
}

/** The proxy, its startup service and its options (plan §5.1). */
export function ProxySection() {
  const { show, dialog } = usePlan();
  return (
    <StatusGate>
      {(status) => (
        <>
          <ProxyState status={status} plan={(a) => show(a)} />
          <Service status={status} plan={(a) => show(a)} />
          <Options status={status} plan={show} />
          {dialog}
        </>
      )}
    </StatusGate>
  );
}
