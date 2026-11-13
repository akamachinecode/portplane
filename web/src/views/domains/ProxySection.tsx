import { useEffect, useId, useState, type ReactNode } from "react";
import type { PortlessAction, PortlessStatus, ProxyOptions } from "../../api/portless";
import { Field, Switch } from "../../components/Controls";
import { Icon, type IconName } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu, type MenuItem } from "../../components/Menu";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { cleanTlds, describeOptions, lowPort, normalizeOptions, optionsProblems, proxyAnswers, proxyUrl, sameOptions, tldProblem, tldWarning } from "../../lib/portless";
import { SettingRow } from "../settings/SettingsGroup";
import { Fact, Fold, Group, ShortPath, StatusLine } from "./Fold";
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
        <a className="btn" href="#/onboarding/install">
          <Icon name="wand" size={14} />
          Install it from Setup
        </a>
      }
    >
      portless gives every dev server a stable https://name.localhost address. Setup installs it without a terminal; then it is managed here.
    </EmptyState>
  );
}

/** Opens a plan for an action, from anywhere in a section. */
export function usePlan() {
  const [open, setOpen] = useState<{ action: PortlessAction; options?: ProxyOptions } | null>(null);
  const dialog = open && <PlanDialog action={open.action} options={open.options} onClose={() => setOpen(null)} />;
  return { show: (action: PortlessAction, options?: ProxyOptions) => setOpen({ action, options }), dialog };
}

function Proxy({ status, plan }: { status: PortlessStatus; plan: (a: PortlessAction) => void }) {
  const p = status.proxy;
  const s = status.service;
  const prog = status.program;
  const { up, port } = proxyAnswers(status);
  const broken = !!(s?.installed && prog && (prog.nodeMissing || prog.scriptMissing));
  const example = proxyUrl(`web.${p.tlds[0] ?? "localhost"}`, p);
  const shield = (admin: boolean, other: IconName): IconName => (admin ? "shield" : other);

  // The one action you'd take now is a button; the others wait in the menu.
  const main: PortlessAction = !up ? "proxy-start" : broken || (s && !s.installed) ? "service-install" : "proxy-restart";
  const items: MenuItem[] = [];
  if (up && main !== "proxy-restart") items.push({ label: "Restart the proxy", icon: "restart", onSelect: () => plan("proxy-restart") });
  if (up) items.push({ label: "Stop the proxy", icon: shield(status.adminToStop, "stop"), onSelect: () => plan("proxy-stop") });
  if (s?.installed && main !== "service-install") items.push({ label: "Reinstall the startup service", icon: "shield", onSelect: () => plan("service-install") });
  if (s?.installed) items.push({ label: "Remove the startup service", icon: "trash", onSelect: () => plan("service-uninstall") });
  if (!up && s && !s.installed) items.push({ label: "Install the startup service", icon: "shield", onSelect: () => plan("service-install") });

  const button =
    main === "proxy-start" ? (
      <button type="button" className="btn btn-primary" onClick={() => plan("proxy-start")}>
        <Icon name={shield(status.adminToStart, "play")} size={13} />
        Start the proxy
      </button>
    ) : main === "service-install" ? (
      <button type="button" className={`btn${broken ? " btn-primary" : ""}`} onClick={() => plan("service-install")}>
        <Icon name="shield" size={13} />
        {broken ? "Reinstall the service" : "Start it with the computer"}
      </button>
    ) : (
      <button type="button" className="btn" onClick={() => plan("proxy-restart")}>
        <Icon name="restart" size={13} />
        Restart
      </button>
    );

  const service = !s ? (
    status.serviceError ? <span className="warn-text">Couldn't ask portless about its startup service: {status.serviceError}</span> : undefined
  ) : broken ? (
    <span className="warn-text">The startup service starts a program that no longer exists, as after a Node.js or portless upgrade. Reinstall it.</span>
  ) : s.installed ? (
    "Starts with the computer"
  ) : (
    "Runs until you stop it or restart the computer"
  );

  return (
    <Group title="Proxy">
      <StatusLine
        state={up ? "on" : "failed"}
        sub={service}
        actions={
          <>
            {button}
            {items.length > 0 && <Menu label="More proxy actions" items={items} />}
          </>
        }
      >
        {up ? `Running on port ${port} with ${p.https ? "HTTPS" : "HTTP"}` : "Not running: your .localhost addresses won't load"}
      </StatusLine>
      {up && (
        <SettingRow label="Addresses">
          <span className="mono">{example}</span>
          {p.tlds.length > 1 && <span className="muted"> · also {p.tlds.slice(1).map((t) => `.${t}`).join(", ")}</span>}
        </SettingRow>
      )}
      {(p.lan || p.unprivileged || p.customCert || status.options.wildcard) && (
        <SettingRow label="Modes">
          <span className="chips">
            {p.lan && <span className="dchip">LAN{p.lanIp ? ` · ${p.lanIp}` : ""}</span>}
            {p.unprivileged && <span className="dchip">Unprivileged</span>}
            {p.customCert && <span className="dchip">Own certificate</span>}
            {status.options.wildcard && <span className="dchip">Wildcard subdomains</span>}
          </span>
        </SettingRow>
      )}
      <Fold summary="Details">
        <dl className="dfacts">
          {p.pid !== undefined && up && (
            <Fact label="Process">
              <span className="mono">PID {p.pid}</span>
              {p.asRoot && <span className="muted"> · runs as administrator</span>}
            </Fact>
          )}
          <Fact label="Startup service">{s ? (s.installed ? `Installed · ${s.managerState}` : "Not installed") : "Unknown"}</Fact>
          {s?.installed && prog && (
            <Fact label="Node.js">
              <ShortPath path={prog.node} />
              {prog.nodeMissing && <span className="tag tag-warn">missing</span>}
            </Fact>
          )}
          {s?.installed && prog?.script && (
            <Fact label="portless">
              <ShortPath path={prog.script} />
              {prog.scriptMissing && <span className="tag tag-warn">missing</span>}
            </Fact>
          )}
          {s?.installed && s.entry && (
            <Fact label="Service file">
              <ShortPath path={s.entry} />
            </Fact>
          )}
        </dl>
      </Fold>
    </Group>
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
    <div className="sgroup">
      <div className="sgroup-body">
        <p className="sgroup-text">{service ? "Applying them reinstalls the startup service, which asks for your password." : "They apply the next time the proxy starts."}</p>
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
            <Field label="LAN address" htmlFor={ids.ip} error={problems.lanIp} hint="Leave it empty to follow this machine's address as it changes.">
              <input id={ids.ip} className="input mono" value={o.lanIp ?? ""} placeholder="192.168.1.20" onChange={(e) => set({ lanIp: e.target.value })} aria-invalid={problems.lanIp ? true : undefined} />
            </Field>
          )}
          <Switch checked={o.unprivileged} onChange={(unprivileged) => set({ unprivileged })} label="Unprivileged" description="Takes a port below 1024 without your password where the system allows it, accepting connections from this computer only. Never writes the hosts file." />
          <Fold className="proxy-cert" summary="Your own certificate" open={!!(current.certPath || current.keyPath) || undefined}>
            <p className="field-hint">Serve a certificate you already have (from mkcert or your company, say) instead of portless's own.</p>
            <Field label="Certificate file" htmlFor={ids.cert} error={problems.certPath}>
              <input id={ids.cert} className="input mono" value={o.certPath ?? ""} placeholder="/home/dev/certs/dev.pem" onChange={(e) => set({ certPath: e.target.value })} />
            </Field>
            <Field label="Key file" htmlFor={ids.key} error={problems.keyPath}>
              <input id={ids.key} className="input mono" value={o.keyPath ?? ""} placeholder="/home/dev/certs/dev-key.pem" onChange={(e) => set({ keyPath: e.target.value })} />
            </Field>
          </Fold>
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
          <button type="button" className="btn" disabled={invalid || (!changed && !!service)} onClick={() => plan("service-install", normalizeOptions(o))} title={describeOptions(normalizeOptions(o))}>
            <Icon name="shield" size={13} />
            {service ? "Apply: reinstall the service" : "Install the service with these options"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What the proxy is, drawn: the browser asks for an address, the proxy
 * answers it with the certificate and passes the request to the app's
 * port. It explains, so it carries no state: the Proxy card says that.
 */
export function ProxyExplainer({ status }: { status: PortlessStatus }) {
  const https = status.proxy.https;
  const tld = status.proxy.tlds[0] ?? "localhost";
  return (
    <>
      <ol className="flow" aria-label="How a request reaches an app">
        <li className="flow-step">
          <span className="flow-kicker">Your browser opens</span>
          <span className="flow-value mono">{https ? "https" : "http"}://web.{tld}</span>
        </li>
        <li className="flow-step flow-proxy">
          <span className="flow-kicker">the proxy, on :{status.proxy.port}</span>
          <span className="flow-value">
            <Icon name="shield" size={14} />
            portless{https ? " · HTTPS" : ""}
          </span>
        </li>
        <li className="flow-step">
          <span className="flow-kicker">passes it to the app</span>
          <span className="flow-value mono">127.0.0.1:4514</span>
        </li>
      </ol>
      <p className="explainer-text">
        An app's port changes from run to run. The proxy stays on one port and knows which name belongs to which port right now, so{" "}
        <span className="mono">web.{tld}</span> always opens <em>web</em>. It also holds the certificate behind the padlock. Without it, apps still run, but their addresses don't load.
      </p>
    </>
  );
}

/** The proxy, its startup service and its options (plan §5.1). */
export function ProxySection() {
  const { show, dialog } = usePlan();
  return (
    <StatusGate>
      {(status) => (
        <>
          <Proxy status={status} plan={(a) => show(a)} />
          <div className="dfolds">
            <Fold className="dfold-section" summary="How it works">
              <ProxyExplainer status={status} />
            </Fold>
            <Fold className="dfold-section" summary="Advanced options" hint="Port, HTTPS, domains, wildcard, LAN">
              <Options status={status} plan={show} />
            </Fold>
          </div>
          {dialog}
        </>
      )}
    </StatusGate>
  );
}
