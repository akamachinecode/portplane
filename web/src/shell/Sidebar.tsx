import { useEffect, useMemo, useState } from "react";
import type { ConnectionStatus } from "../api/events";
import { useApp } from "../components/AppContext";
import { ProjectIcon } from "../components/AppIcons";
import { Icon, type IconName } from "../components/Icon";
import { StateDot } from "../components/StateDot";
import { checklist, checklistVisible, doneCount } from "../lib/gettingStarted";
import { isMac, paletteShortcutLabel } from "../lib/keyboard";
import { sidebarProjects, type SidebarProject } from "../lib/projects";
import { HOME, href, type Route } from "../lib/router";
import { safeLocalStorage } from "../lib/storage";
import { portplaneUpdate, shouldAskAboutUpdates, useUpdateCheck } from "../lib/updateCheck";
import { problemBadge } from "./health";
import { isSettingsRoute, SETTINGS_GROUPS, SETTINGS_NAV } from "./nav";
import { useShell } from "./ShellContext";
import { setSidebarCollapsed } from "./sidebarState";

interface Badge {
  text: string;
  label: string; // for screen readers
  tone?: "error" | "warning" | "live";
}

function NavLink({ route, label, icon, badge, current }: { route: Route; label: string; icon: IconName; badge?: Badge; current: boolean }) {
  return (
    <li>
      <a className="nav-item" href={href(route)} aria-current={current ? "page" : undefined}>
        <Icon name={icon} size={16} className="nav-icon" />
        <span className="nav-label">{label}</span>
        {badge && (
          <span className={`nav-badge${badge.tone ? ` nav-badge-${badge.tone}` : ""}`}>
            <span aria-hidden="true">{badge.text}</span>
            <span className="sr-only">({badge.label})</span>
          </span>
        )}
      </a>
    </li>
  );
}

// Which sidebar groups are folded: a per-browser convenience.
const FOLD_KEY = "portplane.sidebar.folded";

function readFolded(): string[] {
  try {
    const v = JSON.parse(safeLocalStorage()?.getItem(FOLD_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function useFolded(): [ReadonlySet<string>, (id: string) => void] {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(readFolded()));
  const toggle = (id: string) =>
    setFolded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        safeLocalStorage()?.setItem(FOLD_KEY, JSON.stringify([...next]));
      } catch {
        // storage blocked: it lasts until the page reloads
      }
      return next;
    });
  return [folded, toggle];
}

function Group({ id, title, hint, folded, onToggle, action, children }: { id: string; title: string; hint?: string; folded?: boolean; onToggle?(): void; action?: React.ReactNode; children: React.ReactNode }) {
  const listId = `nav-group-${id}`;
  return (
    <div className={`nav-group${folded ? " is-folded" : ""}`}>
      <div className="nav-group-head">
        {onToggle ? (
          <button type="button" className="nav-group-toggle" aria-expanded={!folded} aria-controls={listId} title={hint} onClick={onToggle}>
            <span className="nav-group-title">{title}</span>
            <Icon name="chevronDown" size={12} className="nav-group-chevron" />
          </button>
        ) : (
          <span className="nav-group-toggle is-static" title={hint}>
            <span className="nav-group-title">{title}</span>
          </span>
        )}
        {action}
      </div>
      {!folded && (
        <ul className="nav-list" id={listId}>
          {children}
        </ul>
      )}
    </div>
  );
}

/**
 * A project in the sidebar: its icon and name, and on the right one mark at
 * most (ADR-0032): how many run while some do, or a dot while one is
 * starting or has failed. Nothing running needs no mark.
 */
function ProjectLink({ p, current, showMachine }: { p: SidebarProject; current: boolean; showMachine: boolean }) {
  const { project, ms, state, running, total } = p;
  const stateText = state === "failed" ? "something failed" : state === "starting" ? "starting" : running > 0 ? `${running} of ${total} running` : "nothing running";
  return (
    <li>
      <a className={`nav-item nav-project nav-project-${state}`} href={href(p.route)} aria-current={current ? "page" : undefined} title={`${project.name}${showMachine ? ` on ${ms.machine.name}` : ""}: ${stateText}`}>
        <ProjectIcon ms={ms} project={project} size={18} />
        <span className="nav-label">{project.name}</span>
        {showMachine && !ms.machine.local && <span className="nav-sub">{ms.machine.name}</span>}
        {state === "failed" || state === "starting" ? (
          <StateDot state={state} />
        ) : (
          running > 0 && (
            <span className="nav-count is-live" aria-hidden="true">
              {running}/{total}
            </span>
          )
        )}
        <span className="sr-only">({stateText})</span>
      </a>
    </li>
  );
}

const CONNECTION: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  live: "Live: changes show as they happen",
  reconnecting: "Reconnecting…",
  expired: "Disconnected: reload the window",
};

// Where "Back to app" goes from Settings: the last page of the work.
let lastWorkRoute: Route = HOME;

/**
 * The app's navigation (ADR-0028). The work, on every day: setup while it
 * is unfinished, the apps, their addresses, their health, and every
 * project. Settings swaps it for Settings' own sidebar: Portplane, then
 * dekit, then portless. It runs up to the window's top edge; on macOS the
 * traffic lights sit in its first strip.
 */
export function Sidebar({ onSearch }: { onSearch(): void }) {
  const { info } = useApp();
  const { route, status } = useShell();
  const mac = isMac(info?.os);
  const settings = isSettingsRoute(route);
  useEffect(() => {
    if (!settings) lastWorkRoute = route;
  }, [route, settings]);

  return (
    <nav className={`sidebar${settings ? " is-settings" : ""}`} aria-label={settings ? "Settings" : "Main"}>
      <div className="sidebar-chrome" data-drag-region />
      <div className="sidebar-brand" data-drag-region>
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={20} height={20} className="brand-mark" />
        <span className="brand-name">Portplane</span>
        <span className={`conn conn-${status}`} title={CONNECTION[status]} role="status">
          <StateDot state={status} />
          <span className={status === "live" ? "sr-only" : "conn-label"}>{status === "live" ? "Live" : CONNECTION[status].replace(/:.*/, "")}</span>
        </span>
        <span className="spacer" />
        <button type="button" className="icon-btn sidebar-hide" aria-label="Hide the sidebar" title="Hide the sidebar" onClick={() => setSidebarCollapsed(true)}>
          <Icon name="sidebar" size={16} />
        </button>
      </div>
      {settings ? (
        <SettingsNav />
      ) : (
        <>
          <button type="button" className="sidebar-search" onClick={onSearch} aria-keyshortcuts={mac ? "Meta+K /" : "Control+K /"} aria-label="Search or run a command">
            <Icon name="search" size={14} />
            <span className="sidebar-search-text">Search or run…</span>
            <kbd className="kbd">{paletteShortcutLabel(mac)}</kbd>
          </button>
          <WorkNav />
        </>
      )}
    </nav>
  );
}

function WorkNav() {
  const { route, snapshot, summary, problems, preferences } = useShell();
  const [folded, toggle] = useFolded();
  const projects = useMemo(() => (snapshot ? sidebarProjects(snapshot) : []), [snapshot]);
  const multiMachine = (snapshot?.machines.length ?? 0) > 1;
  const health = problemBadge(problems);
  const local = snapshot?.machines.find((m) => m.machine.local);
  const prefs = preferences.status === "ok" ? preferences.value : null;
  const steps = useMemo(() => checklist(local), [local]);
  const setupLeft = checklistVisible(prefs, steps);
  const onSetup = route.view === "onboarding" && !route.machine;

  const appsBadge: Badge | undefined = summary && summary.running > 0 ? { text: String(summary.running), label: `${summary.running} running`, tone: "live" } : undefined;
  const healthBadge: Badge | undefined =
    health.count > 0 && health.tone ? { text: String(health.count), label: `${health.count} ${health.count === 1 ? "problem" : "problems"}`, tone: health.tone } : undefined;

  const isProject = (p: SidebarProject) =>
    route.view === "project" && route.machine === p.ms.machine.id && route.name === p.project.name && (!route.runner || route.runner === p.project.runner);

  return (
    <>
      <div className="sidebar-scroll">
        {setupLeft && (
          <a className="setup-callout" href={href({ view: "onboarding" })} aria-current={onSetup ? "page" : undefined}>
            <ProgressRing value={doneCount(steps)} max={steps.length} size={20} />
            <span className="setup-callout-text">
              <span className="setup-callout-title">Set up Portplane</span>
              {/* what comes next, not a second count next to Setup's own */}
              <span className="setup-callout-sub">Next: {steps.find((st) => !st.done)?.title ?? "check"}</span>
            </span>
            <Icon name="chevronRight" size={14} className="setup-callout-chevron" />
          </a>
        )}
        <ul className="nav-list">
          <NavLink route={{ view: "apps" }} label="Apps" icon="apps" badge={appsBadge} current={route.view === "apps"} />
          <NavLink route={{ view: "addresses", filter: "all" }} label="Addresses" icon="link" current={route.view === "addresses"} />
          <NavLink route={{ view: "health" }} label="Health" icon="pulse" badge={healthBadge} current={route.view === "health"} />
        </ul>

        <Group
          id="projects"
          title="Projects"
          folded={folded.has("projects")}
          onToggle={() => toggle("projects")}
          action={
            <a className="icon-btn nav-group-action" href={href({ view: "settings", section: "folders" })} aria-label="Add a project folder" title="Add a project folder">
              <Icon name="plus" size={14} />
            </a>
          }
        >
          {projects.map((p) => (
            <ProjectLink key={p.key} p={p} current={isProject(p)} showMachine={multiMachine} />
          ))}
          {snapshot && projects.length === 0 && (
            <li className="nav-empty">
              {(local?.folders.length ?? 0) > 0 ? (
                <>No projects in your folders yet.</>
              ) : (
                <>
                  <a href={href({ view: "settings", section: "folders" })}>Add a folder</a> with your code to see its projects here.
                </>
              )}
            </li>
          )}
        </Group>
      </div>

      <div className="sidebar-foot">
        <UpdateNotice setupLeft={setupLeft} />
        <ul className="nav-list">
          {!setupLeft && <NavLink route={{ view: "onboarding" }} label="Setup" icon="timeline" current={onSetup} />}
          <NavLink route={SETTINGS_NAV.route} label="Settings" icon="gear" current={false} />
        </ul>
      </div>
    </>
  );
}

/**
 * A new Portplane, or (once) whether Portplane may look for one every day
 * (ADR-0031). The update itself runs in Settings › Updates, which shows
 * its progress.
 */
function UpdateNotice({ setupLeft }: { setupLeft: boolean }) {
  const { route, preferences, updatePreferences } = useShell();
  const check = useUpdateCheck();
  const prefs = preferences.status === "ok" ? preferences.value : null;
  const update = portplaneUpdate(check);
  const onUpdates = route.view === "settings" && route.section === "updates";

  if (update) {
    return (
      <a className="setup-callout update-callout" href={href({ view: "settings", section: "updates" })} aria-current={onUpdates ? "page" : undefined}>
        <Icon name="download" size={16} className="update-callout-icon" />
        <span className="setup-callout-text">
          <span className="setup-callout-title">Portplane {update.latest} is out</span>
          <span className="setup-callout-sub">Update and restart</span>
        </span>
        <Icon name="chevronRight" size={14} className="setup-callout-chevron" />
      </a>
    );
  }
  if (!shouldAskAboutUpdates(prefs, setupLeft)) return null;
  const answer = (updateCheck: "manual" | "auto") => void updatePreferences((p) => ({ ...p, updateCheck, updateAsked: true }));
  // Asked once, in one line and neutral buttons: it must not outshout the
  // page's own main action (ADR-0032). The details are in Settings › Updates.
  return (
    <div className="update-ask" role="group" aria-label="Updates" title="Portplane asks GitHub once a day and tells you when there's one. Nothing installs without your click.">
      <span className="update-ask-title">Check for new versions daily?</span>
      <span className="update-ask-actions">
        <button type="button" className="btn btn-sm" onClick={() => answer("auto")}>
          Yes
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => answer("manual")}>
          No
        </button>
      </span>
    </div>
  );
}

/** Settings' own sidebar (as in Linear): back to the work, then Portplane, dekit and portless. */
function SettingsNav() {
  const { route } = useShell();
  return (
    <div className="sidebar-scroll sidebar-settings">
      <a className="nav-back" href={href(lastWorkRoute)}>
        <Icon name="chevronLeft" size={14} />
        Back to app
      </a>
      {SETTINGS_GROUPS.map((g) => (
        <Group key={g.id} id={`settings-${g.id}`} title={g.label} hint={g.hint}>
          {g.links.map((l) => (
            <NavLink key={l.id} route={l.route} label={l.label} icon={l.icon} current={l.current(route)} />
          ))}
        </Group>
      ))}
    </div>
  );
}

/** A small ring that fills as the checklist does. */
export function ProgressRing({ value, max, size = 22 }: { value: number; max: number; size?: number }) {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const filled = max > 0 ? value / max : 0;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} />
      <circle
        className="ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={`${c * filled} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
