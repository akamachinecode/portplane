import { errorText } from "../api/errors";
import { isVisible } from "../lib/apps";
import { navigate } from "../lib/router";
import { entryKey, toggleFavorite } from "../views/apps/model";
import { registerCommandSource, type Command, type CommandContext } from "./commands";

// The palette's M5.5 commands: shortcuts, the Apps layout, pins, the
// diagnostic report and update checks.

/** Opens the ? dialog from anywhere (the shell listens). */
export const SHORTCUTS_EVENT = "portplane:shortcuts";

export function openShortcuts(): void {
  window.dispatchEvent(new Event(SHORTCUTS_EVENT));
}

function polishCommands(ctx: CommandContext): Command[] {
  const prefs = ctx.preferences.status === "ok" ? ctx.preferences.value : null;
  const out: Command[] = [
    { id: "help.shortcuts", title: "Keyboard shortcuts", group: "Settings", icon: "keyboard", keywords: ["keys", "help", "hotkeys"], run: () => openShortcuts() },
    {
      id: "diagnostics.export",
      title: "Export diagnostics",
      group: "Actions",
      icon: "download",
      keywords: ["report", "support", "bug", "zip"],
      async run(c) {
        const saved = await c.api.exportDiagnostics();
        if (saved) c.toast.info(`Saved the report to ${saved.path}`);
      },
    },
    {
      id: "updates.check",
      title: "Check for updates",
      group: "Actions",
      icon: "restart",
      keywords: ["version", "upgrade", "new"],
      async run(c) {
        navigate({ view: "settings", section: "general" });
        try {
          const r = await c.api.checkUpdates();
          const n = r.items.filter((i) => i.update).length;
          c.toast.info(n === 0 ? "Everything is up to date" : n === 1 ? "1 update available: see Settings" : `${n} updates available: see Settings`);
        } catch (err) {
          c.toast.error(`Couldn't check for updates: ${errorText(err)}`);
        }
      },
    },
  ];
  const table = prefs?.appsLayout === "table";
  out.push({
    id: "apps.layout",
    title: table ? "Show apps as cards" : "Show apps as a table",
    group: "Settings",
    icon: table ? "cards" : "table",
    keywords: ["dense", "list", "view", "layout"],
    searchOnly: true,
    run: (c) => {
      navigate({ view: "apps" });
      return c.updatePreferences((p) => ({ ...p, appsLayout: table ? "cards" : "table" }));
    },
  });
  if (prefs && ctx.snapshot) {
    const pinned = new Set(prefs.favorites);
    for (const ms of ctx.snapshot.machines) {
      for (const app of ms.apps) {
        if (!isVisible(app)) continue;
        const key = entryKey(ms.machine.id, app.id);
        const on = pinned.has(key);
        out.push({
          id: `app.${ms.machine.id}.${app.id}.pin`,
          title: `${on ? "Unpin" : "Pin"} ${app.label}`,
          group: "Apps",
          icon: on ? "starFilled" : "star",
          hint: [app.project, app.worktree, ms.machine.name].filter(Boolean).join(" · "),
          keywords: ["favourite", "favorite", "tray"],
          searchOnly: true,
          run: (c) => c.updatePreferences((p) => ({ ...p, favorites: toggleFavorite(p.favorites, key) })),
        });
      }
    }
  }
  return out;
}

registerCommandSource("polish", polishCommands);
