import { describe, expect, it } from "vitest";
import { mockSnapshot } from "../api/mock";
import { DEFAULT_PREFERENCES, normalizePreferences } from "./preferences";
import { appIconKey, appIconPlace, iconChoice, initialsOf, projectIconKey, projectIconPlace, tintOf } from "./icons";
import { initialsFor } from "../components/EntityIcon";

describe("initialsOf", () => {
  it("takes the first letters of the first two words, or one letter of a single word", () => {
    expect(initialsOf("acme-shop")).toBe("AS");
    expect(initialsOf("Repos")).toBe("R");
    expect(initialsOf("acme-billing-platform")).toBe("AB");
    expect(initialsOf("myShop_api")).toBe("MS");
    expect(initialsOf("3d-viewer")).toBe("3V");
    expect(initialsOf("--")).toBe("?");
  });
});

describe("tintOf", () => {
  it("gives a name the same colour every time, one of eight", () => {
    expect(tintOf("acme-shop")).toBe(tintOf("ACME-SHOP"));
    for (const n of ["a", "web", "my-monorepo", "blog", "shop"]) {
      expect(tintOf(n)).toBeGreaterThanOrEqual(1);
      expect(tintOf(n)).toBeLessThanOrEqual(8);
    }
  });
});

describe("icon places and choices", () => {
  const local = mockSnapshot("default").machines[0];
  const web = local.apps.find((a) => a.task === "my-monorepo/web")!;
  const project = local.projects.find((p) => p.name === "my-monorepo")!;

  it("looks for an app's favicon from its folder up to its checkout, and a project's in its repository", () => {
    expect(appIconPlace(local, web)).toEqual({ machine: "local", dir: web.dir, root: web.checkout ?? web.repo });
    expect(projectIconPlace(local, project)?.dir).toBe(project.repo);
  });

  it("reads the user's choice from the preferences, auto otherwise", () => {
    const prefs = { ...DEFAULT_PREFERENCES, icons: { [projectIconKey("local", project)]: { kind: "initials" as const, text: "MM", tint: 3 } } };
    expect(iconChoice(prefs, projectIconKey("local", project))).toEqual({ kind: "initials", text: "MM", tint: 3 });
    expect(iconChoice(prefs, appIconKey("local", web))).toEqual({ kind: "auto" });
    expect(iconChoice(null, "project:x|y")).toEqual({ kind: "auto" });
  });

  it("gives an app without its own icon its project's initials", () => {
    expect(initialsFor("web", { kind: "auto" }, { choice: { kind: "auto" }, name: "acme-shop" })).toEqual({ letters: "AS", tint: 0 });
    expect(initialsFor("web", { kind: "auto" }, { choice: { kind: "initials", text: "X", tint: 2 }, name: "acme-shop" })).toEqual({ letters: "X", tint: 2 });
    expect(initialsFor("web", { kind: "initials", tint: 5 }, { choice: { kind: "auto" }, name: "acme-shop" })).toEqual({ letters: "W", tint: 5 });
  });
});

describe("icons in the preferences", () => {
  it("keeps the choices it understands and drops the rest", () => {
    const p = normalizePreferences({
      icons: {
        "project:local|shop": { kind: "initials", text: "SH", tint: 4 },
        "app:local|/code#shop/web": { kind: "file", machine: "local", path: "/code/shop/logo.svg" },
        "project:local|bad": { kind: "file" },
        "nope": { kind: "initials" },
        "project:local|tint": { kind: "initials", tint: 42 },
      },
    });
    expect(p.icons).toEqual({
      "project:local|shop": { kind: "initials", text: "SH", tint: 4 },
      "app:local|/code#shop/web": { kind: "file", machine: "local", path: "/code/shop/logo.svg" },
      "project:local|tint": { kind: "initials" },
    });
    expect(normalizePreferences({}).icons).toBeUndefined();
  });
});
