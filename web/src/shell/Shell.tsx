import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useApp } from "../components/AppContext";
import { Banner } from "../components/Banner";
import { LoadingState } from "../components/States";
import { isMac, isPaletteShortcut, isTypingTarget } from "../lib/keyboard";
import { installWindowDrag } from "../lib/nativeWindow";
import { href, navigate, type View } from "../lib/router";
import { AppsView } from "../views/AppsView";
import { Announcer } from "./Announcer";
import { firstRunAction } from "../views/onboarding/steps";
// Palette commands and Health problems register when their module loads,
// so they come with the shell even though their views load on first use.
import "../views/onboarding/problems";
import "../views/domains/commands";
import "../views/domains/problems";
import "../views/projects/commands";
import "../views/runners/problems";
import "./agentProblems";
import { BackgroundData } from "./BackgroundData";
import "./builtinCommands";
import { SHORTCUTS_EVENT } from "./polishCommands";
import { CommandPalette } from "./CommandPalette";
import { useShell } from "./ShellContext";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";
import { useSidebarCollapsed } from "./sidebarState";
import { TabBar } from "./TabBar";
import { ToolbarSlot } from "./toolbarSlot";
import { TopBar } from "./TopBar";
import { useGlobalKeys } from "./useGlobalKeys";
import "./shell.css";

// Apps is the first screen and comes with the shell; every other view, and
// the app detail, loads on first use (plan §6.6: first paint under 300 ms).
const ProjectsView = lazy(() => import("../views/ProjectsView").then((m) => ({ default: m.ProjectsView })));
const DomainsView = lazy(() => import("../views/DomainsView").then((m) => ({ default: m.DomainsView })));
const RunnersView = lazy(() => import("../views/RunnersView").then((m) => ({ default: m.RunnersView })));
const MachinesView = lazy(() => import("../views/MachinesView").then((m) => ({ default: m.MachinesView })));
const HealthView = lazy(() => import("../views/HealthView").then((m) => ({ default: m.HealthView })));
const SettingsView = lazy(() => import("../views/SettingsView").then((m) => ({ default: m.SettingsView })));
const OnboardingView = lazy(() => import("../views/OnboardingView").then((m) => ({ default: m.OnboardingView })));
const AppDetail = lazy(() => import("../views/AppDetail").then((m) => ({ default: m.AppDetail })));
const ProjectView = lazy(() => import("../views/ProjectView").then((m) => ({ default: m.ProjectView })));

/** One component per view; each reads the route and the shell's data itself. */
const VIEWS: Record<Exclude<View, "onboarding">, ComponentType> = {
  apps: AppsView,
  project: ProjectView,
  projects: ProjectsView,
  domains: DomainsView,
  runners: RunnersView,
  machines: MachinesView,
  health: HealthView,
  settings: SettingsView,
};

function ExpiredBanner() {
  return (
    <Banner
      tone="error"
      title="Portplane restarted"
      action={
        <button type="button" className="btn" onClick={() => location.reload()}>
          Reload
        </button>
      }
    >
      This page lost its connection. Reload it to see live state again.
    </Banner>
  );
}

/**
 * The app's frame (plan §6.1): sidebar, top bar with the palette, the
 * current view, and the app detail drawer over it. Onboarding takes the
 * whole window.
 */
export function Shell() {
  const { info } = useApp();
  const { route, status, snapshot, preferences, updatePreferences } = useShell();
  const collapsed = useSidebarCollapsed();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const mac = isMac(info?.os);
  useEffect(() => installWindowDrag(), []);
  useGlobalKeys(useCallback(() => setHelp(true), []));
  useEffect(() => {
    const open = () => setHelp(true);
    window.addEventListener(SHORTCUTS_EVENT, open);
    return () => window.removeEventListener(SHORTCUTS_EVENT, open);
  }, []);

  // Ctrl/⌘K or "/" opens the palette, never while the user types.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !isPaletteShortcut(e, mac) || isTypingTarget(e.target)) return;
      e.preventDefault();
      setPalette((open) => (e.key === "/" ? true : !open));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac]);

  // First run (ADR-0027): the app opens on Apps, where the "Get started"
  // checklist leads into the guided setup; someone already set up is
  // marked done without seeing it.
  const firstRun = useRef(false);
  useEffect(() => {
    if (firstRun.current || preferences.status !== "ok" || !snapshot) return;
    const local = snapshot.machines.find((m) => m.machine.local);
    if (!local) return;
    firstRun.current = true;
    if (firstRunAction(preferences.value, local) === "complete") void updatePreferences((p) => ({ ...p, onboarding: { ...p.onboarding, completed: true } }));
  }, [preferences, snapshot, updatePreferences]);

  // An unknown or non-canonical URL becomes the route it showed.
  useEffect(() => {
    if (window.location.hash !== href(route)) navigate(route, { replace: true });
  }, [route]);

  // A new view starts at the top, with its title focused for screen readers.
  const lastView = useRef(route.view);
  useEffect(() => {
    if (lastView.current === route.view) return;
    lastView.current = route.view;
    body.current?.scrollTo({ top: 0 });
    const raf = requestAnimationFrame(() => {
      if (!document.querySelector("dialog[open]")) document.querySelector<HTMLElement>(".toolbar h1, #main h1, .onboarding h1")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [route.view]);

  const paletteEl = palette && <CommandPalette onClose={() => setPalette(false)} />;
  const overlays = (
    <>
      {paletteEl}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
      <Announcer />
      <BackgroundData />
    </>
  );

  if (route.view === "onboarding") {
    return (
      <>
        <Suspense fallback={<LoadingState />}>
          <OnboardingView />
        </Suspense>
        {overlays}
      </>
    );
  }

  const View = VIEWS[route.view];
  return (
    <div className={`shell${collapsed ? " is-collapsed" : ""}`}>
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault(); // a real #main would be read as a route
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <Sidebar onSearch={() => setPalette(true)} />
      <ToolbarSlot value={slot}>
        <div
          className="shell-body"
          ref={body}
          onScroll={(e) => {
            // a line under the toolbar once the page scrolls under it
            const el = e.currentTarget;
            el.classList.toggle("is-scrolled", el.scrollTop > 2);
          }}
        >
          <TopBar slotRef={setSlot} />
          <main id="main" className={`view view-${route.view}`} ref={main} tabIndex={-1}>
            {status === "expired" && <ExpiredBanner />}
            <Suspense fallback={<LoadingState />}>
              <View />
            </Suspense>
          </main>
        </div>
      </ToolbarSlot>
      <TabBar />
      {route.view === "apps" && route.detail && (
        <Suspense fallback={null}>
          <AppDetail key={`${route.detail.machine}|${route.detail.appId}`} target={route.detail} />
        </Suspense>
      )}
      {overlays}
    </div>
  );
}
