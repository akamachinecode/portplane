import { useId, type ReactNode } from "react";
import type { App } from "../../api/types";
import { copyWithToast } from "../../components/appActions";
import { useApp } from "../../components/AppContext";
import { ExcerptPanel } from "../../components/ExcerptPanel";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { StateDot } from "../../components/StateDot";
import { appHref, copyableUrl } from "../../lib/apps";
import { dekitCommand, displayHost, inferHome, shellQuote, shortenPath, stateLabel } from "../../lib/format";
import { appRoute, href as routeHref } from "../../lib/router";
import type { DetailTabProps } from "../AppDetail";
import { DekitHelpHost } from "../runners/DekitHelp";
import { DepGraph, WhySection } from "./WhySection";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="facts-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** What the snapshot knows about an app (plan §4.3, Summary). */
export function SummaryTab({ ms, app }: DetailTabProps) {
  const ctx = useApp();
  const excerptId = useId();
  const machine = ms.machine;
  const home = inferHome([...ms.folders, app.dir, app.runner]);
  const href = app.state === "on" ? appHref(app, machine) : undefined;
  const url = copyableUrl(app, machine, ms.tools);
  const ports = app.ports?.length ? app.ports : app.port ? [app.port] : [];
  const command = app.command?.map(shellQuote).join(" ");
  const byTask = new Map(ms.apps.filter((a) => a.runner === app.runner).map((a) => [a.task, a]));
  const deps = (app.deps ?? []).map((task) => ({ task, app: byTask.get(task) }));
  const dependents = ms.apps.filter((a) => a.runner === app.runner && a.deps?.includes(app.task));

  const depItem = (task: string, dep: App | undefined) => (
    <li key={task} className="dep">
      {dep ? (
        <>
          <StateDot state={dep.state} />
          <a href={routeHref(appRoute(machine.id, dep.id))}>{dep.label}</a>
          <span className="dep-state">{stateLabel(dep.state)}</span>
        </>
      ) : (
        <span className="mono">{task}</span>
      )}
    </li>
  );

  return (
    <div className="summary-tab">
      {app.state === "failed" && (
        <section className="detail-section" aria-labelledby={`${excerptId}-h`}>
          <h3 className="detail-section-title" id={`${excerptId}-h`}>
            Last output
          </h3>
          <ExcerptPanel id={excerptId} machine={machine.id} app={app} />
        </section>
      )}

      {/* What a person needs: where it is and where it lives. The state is
          in the header and explained just below ("Why it is like this"). */}
      <dl className="facts">
        <Row label="Address">
          {href || url ? (
            <span className="fact-inline">
              {href ? (
                <a className="addr" href={href} target="_blank" rel="noopener">
                  {displayHost(href)}
                </a>
              ) : (
                <span className="addr addr-idle">{url ? displayHost(url) : ""}</span>
              )}
              {url && <IconButton icon="copy" label="Copy the URL" onClick={() => void copyWithToast(ctx, url, "the URL")} />}
            </span>
          ) : app.hostname ? (
            <span className="addr addr-idle">{app.hostname}</span>
          ) : (
            <span className="muted">{ms.tools.portless ? "None: its command doesn't go through portless" : "None: portless isn't installed"}</span>
          )}
          {!href && (url || app.hostname) && <p className="fact-note">Works once the app runs{!machine.local ? ", through Portplane's SSH tunnel" : ""}.</p>}
        </Row>
        {ports.length > 0 && (
          <Row label={ports.length > 1 ? "Ports" : "Port"}>
            <span className="mono">{ports.map((p) => `:${p}`).join("  ")}</span>
          </Row>
        )}
        {app.dir && (
          <Row label="Folder">
            <span className="fact-inline">
              <span className="mono fact-path" title={app.dir}>
                {shortenPath(app.dir, home)}
              </span>
              {machine.local && <IconButton icon="folder" label="Reveal the folder" onClick={() => void ctx.pending.run(`reveal|${app.dir}`, null, () => ctx.api.reveal(machine.id, app.dir!))} />}
            </span>
          </Row>
        )}
        <Row label="Project">
          {app.project}
          {app.worktree ? (
            <span className="muted">
              {" "}
              · <Icon name="branch" size={13} className="inline-icon" /> {app.worktree}
            </span>
          ) : (
            <span className="muted"> · main checkout</span>
          )}
        </Row>
      </dl>
      <WhySection ms={ms} app={app} />
      {/* for the curious and for bug reports: folded (ADR-0032) */}
      <details className="tech-details">
        <summary className="tech-summary">
          <Icon name="chevronRight" size={14} className="tech-chevron" />
          Technical details
        </summary>
        <dl className="facts facts-tech">
          <Row label="dekit state">
            {app.rawState ?? stateLabel(app.state)}
            {app.detail && <span className="muted"> · {app.detail}</span>}
          </Row>
          {app.pid ? (
            <Row label="PID">
              <span className="mono">{app.pid}</span>
            </Row>
          ) : null}
          {command && (
            <Row label="Command">
              <span className="fact-inline">
                <code className="fact-code">{command}</code>
                <IconButton icon="copy" label="Copy the command" onClick={() => void copyWithToast(ctx, command, "the command")} />
              </span>
            </Row>
          )}
          <Row label="Kind">{app.kind === "job" ? "Setup step (runs once, then stops)" : "Service (keeps running)"}</Row>
          {deps.length > 0 && (
            <Row label="Needs">
              <ul className="deps">{deps.map((d) => depItem(d.task, d.app))}</ul>
            </Row>
          )}
          {dependents.length > 0 && (
            <Row label="Needed by">
              <ul className="deps">{dependents.map((d) => depItem(d.task, d))}</ul>
            </Row>
          )}
          <Row label="dekit task">
            <span className="fact-inline">
              <code className="fact-code">{dekitCommand(app)}</code>
              <IconButton icon="copy" label="Copy the dekit command" onClick={() => void copyWithToast(ctx, dekitCommand(app), "the command")} />
            </span>
            <p className="fact-note">
              Runner <span className="mono">{shortenPath(app.runner, home)}</span> on {machine.name}
            </p>
          </Row>
        </dl>
        {(deps.length > 0 || dependents.length > 0) && <DepGraph ms={ms} app={app} />}
      </details>
      <DekitHelpHost />
    </div>
  );
}
