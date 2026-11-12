import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { App, MachineSnapshot } from "../api/types";
import { actOnApp, appKey } from "../components/appActions";
import { useApp } from "../components/AppContext";
import { Drawer } from "../components/Drawer";
import { Icon } from "../components/Icon";
import { IconButton } from "../components/IconButton";
import { EmptyState, LoadingState } from "../components/States";
import { StateDot } from "../components/StateDot";
import { appHref, isAlive } from "../lib/apps";
import { stateLabel } from "../lib/format";
import { APP_TABS, appRoute, navigate, type AppRef, type AppTab } from "../lib/router";
import { useShell } from "../shell/ShellContext";
import { ConfigTab } from "./detail/ConfigTab";
import { OutputTab } from "./detail/OutputTab";
import { SummaryTab } from "./detail/SummaryTab";
import { UrlTab } from "./detail/UrlTab";
import "./AppDetail.css";

/** What every tab gets. Each tab is its own file in detail/, so it can grow on its own. */
export interface DetailTabProps {
  ms: MachineSnapshot;
  app: App;
}

const TABS: Record<AppTab, { label: string; Panel: (props: DetailTabProps) => ReactNode }> = {
  summary: { label: "Summary", Panel: SummaryTab },
  output: { label: "Output", Panel: OutputTab },
  config: { label: "Config", Panel: ConfigTab },
  url: { label: "URL", Panel: UrlTab },
};

const close = () => navigate({ view: "apps" });

function Header({ ms, app, titleId }: DetailTabProps & { titleId: string }) {
  const ctx = useApp();
  const machine = ms.machine.id;
  const alive = isAlive(app.state);
  const key = appKey(machine, app);
  const busy = ctx.pending.hasPrefix(key);
  const href = app.state === "on" ? appHref(app, ms.machine) : undefined;
  const canAct = !!ms.tools.dekit && (ms.machine.local || ms.machine.status === "online");
  const toggle = alive ? "stop" : "start";
  const where = [app.project, app.worktree, ms.machine.name].filter(Boolean).join(" · ");
  return (
    <header className="detail-head">
      <div className="detail-title-row">
        <StateDot state={app.state} />
        <h2 className="detail-title" id={titleId} tabIndex={-1} data-autofocus>
          {app.label}
        </h2>
        <span className={`detail-state state-${app.state}`}>{stateLabel(app.state)}</span>
        <span className="spacer" />
        <div className="detail-actions">
          {href && (
            <a className="icon-btn" href={href} target="_blank" rel="noopener" aria-label={`Open ${app.label}`} title={`Open ${app.label}`}>
              <Icon name="open" />
            </a>
          )}
          {canAct && (
            <IconButton
              icon={alive ? "stop" : "play"}
              tone={alive ? "halt" : "go"}
              label={`${alive ? "Stop" : "Start"} ${app.label}`}
              pending={ctx.pending.has(key + toggle)}
              busy={busy}
              onClick={() => void actOnApp(ctx, machine, app, toggle)}
            />
          )}
          {canAct && alive && (
            <IconButton icon="restart" label={`Restart ${app.label}`} pending={ctx.pending.has(key + "restart")} busy={busy} onClick={() => void actOnApp(ctx, machine, app, "restart")} />
          )}
          <span className="detail-actions-sep" aria-hidden="true" />
          <IconButton icon="close" label="Close details" onClick={close} />
        </div>
      </div>
      <p className="detail-where">{where}</p>
    </header>
  );
}

function Tabs({ target, ids }: { target: AppRef & { tab: AppTab }; ids: (tab: AppTab) => { tab: string; panel: string } }) {
  const list = useRef<HTMLDivElement>(null);
  const select = (tab: AppTab, focus: boolean) => {
    navigate(appRoute(target.machine, target.appId, tab), { replace: true });
    if (focus) list.current?.querySelector<HTMLElement>(`#${CSS.escape(ids(tab).tab)}`)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const i = APP_TABS.indexOf(target.tab);
    const next =
      e.key === "ArrowRight" ? APP_TABS[(i + 1) % APP_TABS.length]
      : e.key === "ArrowLeft" ? APP_TABS[(i - 1 + APP_TABS.length) % APP_TABS.length]
      : e.key === "Home" ? APP_TABS[0]
      : e.key === "End" ? APP_TABS[APP_TABS.length - 1]
      : null;
    if (!next) return;
    e.preventDefault();
    select(next, true);
  };
  return (
    <div className="detail-tabs" role="tablist" aria-label="App details" ref={list} onKeyDown={onKeyDown}>
      {APP_TABS.map((tab) => {
        const selected = tab === target.tab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            id={ids(tab).tab}
            aria-selected={selected}
            aria-controls={ids(tab).panel}
            tabIndex={selected ? 0 : -1}
            className="detail-tab"
            onClick={() => select(tab, false)}
          >
            {TABS[tab].label}
          </button>
        );
      })}
    </div>
  );
}

/** An app's details over the current view (route #/apps/<machine>/<appId>/<tab>). */
export function AppDetail({ target }: { target: AppRef & { tab: AppTab } }) {
  const { snapshot } = useShell();
  const titleId = useId();
  const base = useId();
  const ids = (tab: AppTab) => ({ tab: `${base}-tab-${tab}`, panel: `${base}-panel-${tab}` });
  const ms = snapshot?.machines.find((m) => m.machine.id === target.machine);
  const app = ms?.apps.find((a) => a.id === target.appId);

  let body;
  if (!snapshot) {
    body = (
      <>
        <h2 className="sr-only" id={titleId}>
          App details
        </h2>
        <LoadingState label="Connecting to Portplane…" />
      </>
    );
  } else if (!ms || !app) {
    body = (
      <>
        <header className="detail-head detail-head-plain">
          <h2 className="detail-title" id={titleId} tabIndex={-1} data-autofocus>
            App not found
          </h2>
          <IconButton icon="close" label="Close details" onClick={close} />
        </header>
        <EmptyState icon="apps" title={ms ? "This app isn't in the config any more" : "This machine isn't connected any more"}>
          It may have been renamed or removed. Its other apps are still in the list.
        </EmptyState>
      </>
    );
  } else {
    const { Panel } = TABS[target.tab];
    body = (
      <>
        <Header ms={ms} app={app} titleId={titleId} />
        <Tabs target={target} ids={ids} />
        <div className="detail-panel" role="tabpanel" id={ids(target.tab).panel} aria-labelledby={ids(target.tab).tab} tabIndex={0}>
          <Panel ms={ms} app={app} />
        </div>
      </>
    );
  }
  return (
    <Drawer labelledBy={titleId} onClose={close}>
      {body}
    </Drawer>
  );
}
