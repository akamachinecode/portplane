import { useEffect, useRef, useState, type ComponentType } from "react";
import { useApp } from "../components/AppContext";
import { Banner } from "../components/Banner";
import { isMac, isPaletteShortcut, isTypingTarget } from "../lib/keyboard";
import { href, navigate, type View } from "../lib/router";
import { AppDetail } from "../views/AppDetail";
import { AppsView } from "../views/AppsView";
import { DomainsView } from "../views/DomainsView";
import { HealthView } from "../views/HealthView";
import { MachinesView } from "../views/MachinesView";
import { OnboardingView } from "../views/OnboardingView";
import { ProjectsView } from "../views/ProjectsView";
import { RunnersView } from "../views/RunnersView";
import { SettingsView } from "../views/SettingsView";
import "./builtinCommands";
import { CommandPalette } from "./CommandPalette";
import { useShell } from "./ShellContext";
import { Sidebar } from "./Sidebar";
import { useSidebarCollapsed } from "./sidebarState";
import { TopBar } from "./TopBar";
import "./shell.css";

/** One component per view; each reads the route and the shell's data itself. */
const VIEWS: Record<Exclude<View, "onboarding">, ComponentType> = {
  apps: AppsView,
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
  const { route, status } = useShell();
  const collapsed = useSidebarCollapsed();
  const [palette, setPalette] = useState(false);
  const main = useRef<HTMLElement>(null);
  const mac = isMac(info?.os);

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

  // An unknown or non-canonical URL becomes the route it showed.
  useEffect(() => {
    if (window.location.hash !== href(route)) navigate(route, { replace: true });
  }, [route]);

  // A new view starts at the top, with its title focused for screen readers.
  const lastView = useRef(route.view);
  useEffect(() => {
    if (lastView.current === route.view) return;
    lastView.current = route.view;
    window.scrollTo({ top: 0 });
    const raf = requestAnimationFrame(() => {
      if (!document.querySelector("dialog[open]")) document.querySelector<HTMLElement>("#main h1, .onboarding h1")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [route.view]);

  const paletteEl = palette && <CommandPalette onClose={() => setPalette(false)} />;

  if (route.view === "onboarding") {
    return (
      <>
        <OnboardingView />
        {paletteEl}
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
      <Sidebar />
      <div className="shell-body">
        <TopBar onSearch={() => setPalette(true)} />
        <main id="main" className="view" ref={main} tabIndex={-1}>
          {status === "expired" && <ExpiredBanner />}
          <View />
        </main>
      </div>
      {route.view === "apps" && route.detail && <AppDetail key={`${route.detail.machine}|${route.detail.appId}`} target={route.detail} />}
      {paletteEl}
    </div>
  );
}
