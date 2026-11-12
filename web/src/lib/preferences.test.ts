import { describe, expect, it } from "vitest";
import type { Preferences } from "../api/types";
import {
  applyAppearance,
  cacheAppearance,
  cachedAppearance,
  DEFAULT_PREFERENCES,
  needsOnboarding,
  normalizePreferences,
  preferencesProblem,
  themeAttribute,
  type AttributeTarget,
} from "./preferences";

function fakeRoot() {
  const attrs = new Map<string, string>();
  const el: AttributeTarget = {
    setAttribute: (n, v) => void attrs.set(n, v),
    removeAttribute: (n) => void attrs.delete(n),
  };
  return { el, attrs };
}

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("theme and density on <html>", () => {
  it("maps each theme to data-theme, removing it for system", () => {
    expect(themeAttribute("system")).toBeNull();
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });

  it("sets and clears the attributes", () => {
    const { el, attrs } = fakeRoot();
    applyAppearance(el, { theme: "dark", density: "compact" });
    expect(Object.fromEntries(attrs)).toEqual({ "data-theme": "dark", "data-density": "compact" });
    applyAppearance(el, { theme: "system", density: "comfortable" });
    expect(Object.fromEntries(attrs)).toEqual({ "data-density": "comfortable" });
  });

  it("remembers the last appearance for the next start", () => {
    const storage = fakeStorage();
    expect(cachedAppearance(storage)).toBeNull();
    cacheAppearance(storage, { theme: "light", density: "compact" });
    expect(cachedAppearance(storage)).toEqual({ theme: "light", density: "compact" });
    storage.m.set("portplane.appearance", "{broken");
    expect(cachedAppearance(storage)).toBeNull();
    expect(cachedAppearance(undefined)).toBeNull();
  });

  it("survives storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => cacheAppearance(throwing, { theme: "dark", density: "compact" })).not.toThrow();
    expect(cachedAppearance(throwing)).toBeNull();
  });
});

describe("normalizePreferences", () => {
  it("keeps a full, valid object as it is", () => {
    const p: Preferences = {
      theme: "dark",
      density: "compact",
      favorites: ["local|/home/dev/code#web"],
      notifications: { failures: false, recoveries: true, jobs: false },
      updateCheck: "auto",
      onboarding: { completed: true, skipped: false, step: "folders", done: ["welcome", "tools"] },
    };
    expect(normalizePreferences(p)).toEqual(p);
  });

  it("fills what an older or newer binary leaves out or does not know", () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences({ theme: "sepia", density: 3, favorites: ["a", 1], notifications: { jobs: false }, onboarding: { completed: "yes" } })).toEqual({
      ...DEFAULT_PREFERENCES,
      favorites: ["a"],
      notifications: { ...DEFAULT_PREFERENCES.notifications, jobs: false },
    });
  });

  it("keeps the onboarding's choices, dropping values that are not strings", () => {
    const p = normalizePreferences({ onboarding: { completed: false, skipped: true, step: "proxy", done: ["welcome"], choices: { proxy: "unprivileged", bad: 3 } } });
    expect(p.onboarding).toEqual({ completed: false, skipped: true, step: "proxy", done: ["welcome"], choices: { proxy: "unprivileged" } });
    expect(normalizePreferences({ onboarding: { choices: "x" } }).onboarding.choices).toBeUndefined();
  });

  it("returns a fresh object, never the defaults themselves", () => {
    const p = normalizePreferences({});
    p.favorites.push("x");
    expect(DEFAULT_PREFERENCES.favorites).toEqual([]);
  });
});

describe("preferencesProblem", () => {
  it("refuses values the server refuses", () => {
    expect(preferencesProblem(DEFAULT_PREFERENCES)).toBeNull();
    expect(preferencesProblem({ ...DEFAULT_PREFERENCES, theme: "sepia" as Preferences["theme"] })).toMatch(/theme/);
    expect(preferencesProblem({ ...DEFAULT_PREFERENCES, updateCheck: "daily" as Preferences["updateCheck"] })).toMatch(/updateCheck/);
  });
});

describe("needsOnboarding", () => {
  it("is true until onboarding is completed or skipped", () => {
    expect(needsOnboarding(DEFAULT_PREFERENCES)).toBe(true);
    expect(needsOnboarding({ ...DEFAULT_PREFERENCES, onboarding: { completed: false, skipped: true, done: [] } })).toBe(false);
    expect(needsOnboarding({ ...DEFAULT_PREFERENCES, onboarding: { completed: true, skipped: false, done: [] } })).toBe(false);
  });
});
