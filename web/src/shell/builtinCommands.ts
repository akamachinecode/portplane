import type { App, MachineSnapshot, Theme } from "../api/types";
import { actOnApp, copyWithToast } from "../components/appActions";
import { appHref, copyableUrl, isAlive, isVisible } from "../lib/apps";
import { inferHome, shortenPath } from "../lib/format";
import { appRoute, DOMAIN_SECTIONS, navigate, SETTINGS_SECTIONS } from "../lib/router";
import { registerCommandSource, type Command, type CommandContext } from "./commands";
import { sidebarProjects } from "../lib/projects";
import { DOMAIN_GROUPS, DOMAIN_LABELS, NAV, SETTINGS_LABELS, SETTINGS_NAV } from "./nav";
import { isSidebarCollapsed, setSidebarCollapsed } from "./sidebarState";

// The palette's built-in commands. Other files add theirs the same way:
// registerCommandSource(id, (ctx) => Command[]) or useCommands in a view.

function navigationCommands(): Command[] {
  const views = [...NAV, SETTINGS_NAV].map<Command>((item) => ({
    id: `go.${item.view}`,
    title: item.label,
    group: "Go to",
    icon: item.icon,
    keywords: item.view === "settings" ? ["preferences", "options"] : undefined,
    run: () => navigate(item.route),
  }));
  const groups = DOMAIN_GROUPS.map<Command>((g) => ({
    id: `go.portless.${g.id}`,
    title: `portless: ${g.label}`,
    group: "Go to",
    icon: g.icon,
    keywords: ["domains", ...g.sections.map((s) => DOMAIN_LABELS[s])],
    run: () => navigate({ view: "domains", section: g.sections[0] }),
  }));
  const domains = DOMAIN_SECTIONS.map<Command>((section) => ({
    id: `go.domains.${section}`,
    title: `portless: ${DOMAIN_LABELS[section]}`,
    group: "Go to",
    icon: "globe",
    keywords: ["domains"],
    searchOnly: true,
    run: () => navigate({ view: "domains", section }),
  }));
  const settings = SETTINGS_SECTIONS.map<Command>((section) => ({
    id: `go.settings.${section}`,
    title: `Settings: ${SETTINGS_LABELS[section]}`,
    group: "Go to",
    icon: "gear",
    searchOnly: true,
    run: () => navigate({ view: "settings", section }),
  }));
  return [...views.filter((v) => v.id !== "go.domains"), ...groups, ...domains, ...settings];
}

/** Every project, to open its page. */
function projectCommands(ctx: CommandContext): Command[] {
  if (!ctx.snapshot) return [];
  const multi = ctx.snapshot.machines.length > 1;
  return sidebarProjects(ctx.snapshot).map((p) => ({
    id: `project.${p.key}`,
    title: p.project.name,
    group: "Projects",
    icon: "box",
    hint: [p.running > 0 ? `${p.running} of ${p.total} running` : `${p.total} ${p.total === 1 ? "app" : "apps"}`, multi ? p.ms.machine.name : ""].filter(Boolean).join(" · "),
    keywords: [...p.project.worktrees.map((w) => w.name), ...p.project.worktrees.map((w) => w.branch ?? "")].filter(Boolean),
    searchOnly: true,
    run: () => navigate(p.route),
  }));
}

function where(ms: MachineSnapshot, app: App): string {
  return [app.project, app.worktree, ms.machine.name].filter(Boolean).join(" · ");
}

function appCommands(ms: MachineSnapshot, app: App): Command[] {
  const machine = ms.machine.id;
  const hint = where(ms, app);
  const keywords = [app.hostname ?? "", app.task].filter(Boolean);
  const base = `app.${machine}.${app.id}`;
  const out: Command[] = [
    {
      id: `${base}.details`,
      title: app.label,
      group: "Apps",
      icon: "panelRight",
      hint,
      keywords: [...keywords, "details"],
      run: () => navigate(appRoute(machine, app.id)),
    },
  ];
  const href = app.state === "on" ? appHref(app, ms.machine) : undefined;
  if (href) {
    out.push({
      id: `${base}.open`,
      title: `Open ${app.label}`,
      group: "Apps",
      icon: "open",
      hint,
      keywords,
      searchOnly: true,
      // Portplane opens it, like "Open all running": works the same in the native window
      run: (ctx) => ctx.api.open(machine, [href]),
    });
  }
  const alive = isAlive(app.state);
  // Without dekit there is nothing to start or stop with.
  if (ms.tools.dekit && (ms.machine.local || ms.machine.status === "online")) {
    out.push({
      id: `${base}.toggle`,
      title: `${alive ? "Stop" : "Start"} ${app.label}`,
      group: "Apps",
      icon: alive ? "stop" : "play",
      hint,
      keywords,
      searchOnly: true,
      run: (ctx) => actOnApp(ctx, machine, app, alive ? "stop" : "start"),
    });
    if (alive) {
      out.push({
        id: `${base}.restart`,
        title: `Restart ${app.label}`,
        group: "Apps",
        icon: "restart",
        hint,
        keywords,
        searchOnly: true,
        run: (ctx) => actOnApp(ctx, machine, app, "restart"),
      });
    }
  }
  const url = copyableUrl(app, ms.machine, ms.tools);
  if (url) {
    out.push({
      id: `${base}.copy`,
      title: `Copy URL of ${app.label}`,
      group: "Apps",
      icon: "link",
      hint,
      keywords: [...keywords, url],
      searchOnly: true,
      run: (ctx) => copyWithToast(ctx, url, "the URL"),
    });
  }
  return out;
}

function appsCommands(ctx: CommandContext): Command[] {
  if (!ctx.snapshot) return [];
  return ctx.snapshot.machines.flatMap((ms) => ms.apps.filter(isVisible).flatMap((app) => appCommands(ms, app)));
}

function actionCommands(ctx: CommandContext): Command[] {
  const out: Command[] = [];
  const local = ctx.snapshot?.machines.find((m) => m.machine.local);
  const folders = local?.folders ?? [];
  const home = inferHome(folders);
  for (const folder of folders) {
    out.push({
      id: `setup.${folder}`,
      title: `Set up ${shortenPath(folder, home)}`,
      group: "Actions",
      icon: "wand",
      keywords: ["folder", "scan", "configure"],
      run: (c) => c.openSetup(folder),
    });
  }
  out.push({
    id: "folders.add",
    title: folders.length ? "Add a folder" : "Set up a folder",
    group: "Actions",
    icon: "folder",
    keywords: ["folders", "watch", "projects"],
    run: () => navigate({ view: "settings", section: "folders" }),
  });
  out.push({
    id: "machines.add",
    title: "Add a machine",
    group: "Machines",
    icon: "plus",
    keywords: ["ssh", "remote", "tailscale"],
    run: (c) => c.openAddMachine(),
  });
  for (const ms of ctx.snapshot?.machines ?? []) {
    if (ms.machine.local) continue;
    const m = ms.machine;
    out.push(
      { id: `machines.edit.${m.id}`, title: `Edit ${m.name}`, group: "Machines", icon: "pencil", searchOnly: true, run: (c) => c.openEditMachine(m.id) },
      ...(m.status === "online"
        ? [
            {
              id: `machines.setup.${m.id}`,
              title: `Set up ${m.name}`,
              group: "Machines",
              icon: "wand" as const,
              keywords: ["install", "dekit", "portless", "proxy", "onboarding"],
              searchOnly: true,
              run: () => navigate({ view: "onboarding", machine: m.id }),
            },
            {
              id: `machines.runners.${m.id}`,
              title: `Runners on ${m.name}`,
              group: "Go to",
              icon: "layers" as const,
              keywords: ["dekit"],
              searchOnly: true,
              run: () => navigate({ view: "runners", machine: m.id }),
            },
            {
              id: `machines.domains.${m.id}`,
              title: `Domains on ${m.name}`,
              group: "Go to",
              icon: "globe" as const,
              keywords: ["portless", "proxy", "routes"],
              searchOnly: true,
              run: () => navigate({ view: "domains", section: "proxy", machine: m.id }),
            },
          ]
        : []),
      { id: `machines.remove.${m.id}`, title: `Remove ${m.name}`, group: "Machines", icon: "trash", searchOnly: true, run: (c) => c.openRemoveMachine(m) },
    );
  }
  out.push({
    id: "page.reload",
    title: "Reload the page",
    group: "Actions",
    icon: "restart",
    keywords: ["refresh"],
    run: () => location.reload(),
  });
  return out;
}

const THEME_TITLES: Record<Theme, string> = { system: "Use the system theme", light: "Use the light theme", dark: "Use the dark theme" };

function settingsCommands(ctx: CommandContext): Command[] {
  const prefs = ctx.preferences.status === "ok" ? ctx.preferences.value : null;
  const out: Command[] = [];
  for (const theme of ["system", "light", "dark"] as const) {
    if (prefs?.theme === theme) continue;
    out.push({
      id: `theme.${theme}`,
      title: THEME_TITLES[theme],
      group: "Settings",
      icon: theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor",
      keywords: ["appearance", "colour", "color", "mode"],
      searchOnly: true,
      run: (c) => c.updatePreferences((p) => ({ ...p, theme })),
    });
  }
  const compact = prefs?.density === "compact";
  out.push({
    id: "density.toggle",
    title: compact ? "Use comfortable density" : "Use compact density",
    group: "Settings",
    icon: compact ? "rows" : "rowsCompact",
    keywords: ["dense", "spacing", "appearance"],
    searchOnly: true,
    run: (c) => c.updatePreferences((p) => ({ ...p, density: compact ? "comfortable" : "compact" })),
  });
  const collapsed = isSidebarCollapsed();
  out.push({
    id: "sidebar.toggle",
    title: collapsed ? "Show the sidebar" : "Hide the sidebar",
    group: "Settings",
    icon: "sidebar",
    searchOnly: true,
    run: () => setSidebarCollapsed(!collapsed),
  });
  out.push({
    id: "onboarding.open",
    title: "Open the guided setup",
    group: "Settings",
    icon: "wand",
    keywords: ["onboarding", "guided setup", "first run"],
    searchOnly: true,
    run: () => navigate({ view: "onboarding" }),
  });
  return out;
}

registerCommandSource("builtin.navigation", navigationCommands);
registerCommandSource("builtin.projects", projectCommands);
registerCommandSource("builtin.apps", appsCommands);
registerCommandSource("builtin.actions", actionCommands);
registerCommandSource("builtin.settings", settingsCommands);
