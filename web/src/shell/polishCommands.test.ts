import { describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../api/mock";
import type { Preferences } from "../api/types";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
import { collectCommands, type CommandContext } from "./commands";
import "./polishCommands";

function ctx(prefs: Preferences) {
  let saved = prefs;
  const updatePreferences = vi.fn(async (fn: (p: Preferences) => Preferences) => {
    saved = fn(saved);
    return true;
  });
  return { c: { preferences: { status: "ok", value: prefs }, snapshot: mockSnapshot("default"), updatePreferences } as unknown as CommandContext, saved: () => saved };
}

describe("polish commands", () => {
  it("pins and unpins apps, and switches the Apps layout", async () => {
    const pinnedKey = "local|/home/dev/code#my-monorepo/web";
    const { c, saved } = ctx({ ...DEFAULT_PREFERENCES, favorites: [pinnedKey] });
    const cmds = collectCommands(c);
    const byId = (id: string) => cmds.find((x) => x.id === id)!;
    expect(byId("app.local./home/dev/code#my-monorepo/web.pin").title).toBe("Unpin web");
    expect(byId("app.local./home/dev/code#blog/site.pin").title).toBe("Pin site");
    expect(byId("apps.layout").title).toBe("Show apps as a table");
    expect(byId("help.shortcuts")).toBeDefined();
    await byId("app.local./home/dev/code#blog/site.pin").run(c);
    expect(saved().favorites).toEqual([pinnedKey, "local|/home/dev/code#blog/site"]);
  });
});
