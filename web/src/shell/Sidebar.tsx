import { useMemo, useState } from "react";
import type { ConnectionStatus } from "../api/events";
import { useApp } from "../components/AppContext";
import { Icon, type IconName } from "../components/Icon";
import { StateDot } from "../components/StateDot";
import { checklist, checklistVisible, doneCount } from "../lib/gettingStarted";
import { isMac, paletteShortcutLabel } from "../lib/keyboard";
import { sidebarProjects, type SidebarProject } from "../lib/projects";
import { href, sameRoute, type Route } from "../lib/router";
import { safeLocalStorage } from "../lib/storage";
import { problemBadge } from "./health";
import { SETTINGS_NAV, TOOL_GROUPS } from "./nav";
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

function Group({ id, title, hint, folded, onToggle, action, children }: { id: string; title: string; hint?: string; folded: boolean; onToggle(): void; action?: React.ReactNode; children: React.ReactNode }) {
  const listId = `nav-group-${id}`;
  return (
    <div className={`nav-group${folded ? " is-folded" : ""}`}>
      <div className="nav-group-head">
        <button type="button" className="nav-group-toggle" aria-expanded={!folded} aria-controls={listId} title={hint} onClick={onToggle}>
          <span className="nav-group-title">{title}</span>
          <Icon name="chevronDown" size={12} className="nav-group-chevron" />
        </button>
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

function ProjectLink({ p, current, showMachine }: { p: SidebarProject; current: boolean; showMachine: boolean }) {
  const { project, ms, state, running, total } = p;
  const stateText = state === "failed" ? "something failed" : state === "starting" ? "starting" : running > 0 ? `${running} of ${total} running` : "nothing running";
  return (
    <li>
      <a className={`nav-item nav-project nav-project-${state}`} href={href(p.route)} aria-current={current ? "page" : undefined} title={`${project.name}${showMachine ? ` on ${ms.machine.name}` : ""}: ${stateText}`}>
        <StateDot state={state} />
        <span className="nav-label">{project.name}</span>
        {showMachine && !ms.machine.local && <span className="nav-sub">{ms.machine.name}</span>}
        <span className={`nav-count${running > 0 ? " is-live" : ""}`} aria-hidden="true">
          {running > 0 ? `${running}/${total}` : total}
        </span>
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

/**
 * The app's navigation (ADR-0027): the apps, their health and the machines
 * on top, then the dekit and portless sections, then every project (the
 * long list, last), and settings at the foot. It runs up to the
 * window's top edge; on macOS the traffic lights sit in its first strip.
 */
export function Sidebar({ onSearch }: { onSearch(): void }) {
  const { info } = useApp();
  const { route, snapshot, summary, problems, status, preferences } = useShell();
  const [folded, toggle] = useFolded();
  const mac = isMac(info?.os);
  const projects = useMemo(() => (snapshot ? sidebarProjects(snapshot) : []), [snapshot]);
  const multiMachine = (snapshot?.machines.length ?? 0) > 1;
  const health = problemBadge(problems);
  const local = snapshot?.machines.find((m) => m.machine.local);
  const prefs = preferences.status === "ok" ? preferences.value : null;
  const steps = useMemo(() => checklist(local), [local]);
  const setupLeft = checklistVisible(prefs, steps);
  const remoteCount = (snapshot?.machines.length ?? 1) - 1;

  const appsBadge: Badge | undefined = summary && summary.running > 0 ? { text: String(summary.running), label: `${summary.running} running`, tone: "live" } : undefined;
  const healthBadge: Badge | undefined =
    health.count > 0 && health.tone ? { text: String(health.count), label: `${health.count} ${health.count === 1 ? "problem" : "problems"}`, tone: health.tone } : undefined;

  const isProject = (p: SidebarProject) =>
    route.view === "project" && route.machine === p.ms.machine.id && route.name === p.project.name && (!route.runner || route.runner === p.project.runner);

  return (
    <nav className="sidebar" aria-label="Main">
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
      <button type="button" className="sidebar-search" onClick={onSearch} aria-keyshortcuts={mac ? "Meta+K /" : "Control+K /"} aria-label="Search or run a command">
        <Icon name="search" size={14} />
        <span className="sidebar-search-text">Search or run…</span>
        <kbd className="kbd">{paletteShortcutLabel(mac)}</kbd>
      </button>

      <div className="sidebar-scroll">
        <ul className="nav-list">
          <NavLink route={{ view: "apps" }} label="Apps" icon="apps" badge={appsBadge} current={route.view === "apps"} />
          <NavLink route={{ view: "health" }} label="Health" icon="pulse" badge={healthBadge} current={route.view === "health"} />
          <NavLink
            route={{ view: "machines" }}
            label="Machines"
            icon="machine"
            current={route.view === "machines"}
            badge={remoteCount > 0 ? { text: String(remoteCount + 1), label: `${remoteCount + 1} machines` } : undefined}
          />
        </ul>

        {TOOL_GROUPS.map((g) => (
          <Group key={g.id} id={g.id} title={g.label} hint={g.hint} folded={folded.has(g.id)} onToggle={() => toggle(g.id)}>
            {g.links.map((l) => (
              <NavLink key={l.id} route={l.route} label={l.label} icon={l.icon} current={l.current(route)} />
            ))}
          </Group>
        ))}

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
              <a href={href({ view: "settings", section: "folders" })}>Add a folder</a> with your code to see its projects here.
            </li>
          )}
        </Group>
      </div>

      <div className="sidebar-foot">
        {setupLeft && (
          <a className="setup-progress" href={href({ view: "apps" })} title="The steps left to set up Portplane">
            <ProgressRing value={doneCount(steps)} max={steps.length} />
            <span className="setup-progress-text">
              <span className="setup-progress-title">Get started</span>
              <span className="setup-progress-sub">
                {doneCount(steps)} of {steps.length} done
              </span>
            </span>
          </a>
        )}
        <ul className="nav-list">
          <NavLink route={SETTINGS_NAV.route} label="Settings" icon="gear" current={route.view === "settings" || sameRoute(route, SETTINGS_NAV.route)} />
        </ul>
      </div>
    </nav>
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
