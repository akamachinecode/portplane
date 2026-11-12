import type { AppsLayout, Density, Preferences, Theme } from "../api/types";
import type { IconChoice } from "./icons";

// Preferences (GET/PUT /api/preferences) and how theme and density reach the
// page: <html data-theme="light|dark"> (none for "system") and
// <html data-density="comfortable|compact">. styles.css does the rest.

export const THEMES: readonly Theme[] = ["system", "light", "dark"];
export const DENSITIES: readonly Density[] = ["comfortable", "compact"];
const UPDATE_CHECKS = ["manual", "auto"] as const;
export const APPS_LAYOUTS: readonly AppsLayout[] = ["cards", "table"];

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  density: "comfortable",
  favorites: [],
  // Only failures notify until the user turns more on (plan §6.5).
  notifications: { failures: true, recoveries: false, jobs: false, config: false },
  updateCheck: "manual",
  updateAsked: false,
  onboarding: { completed: false, skipped: false, done: [] },
  appsLayout: "cards",
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const stringMap = (v: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));

/**
 * Preferences as the UI uses them, whatever the server sent: fields an older
 * or newer binary leaves out, or fills with values this UI does not know,
 * fall back to the defaults.
 */
export function normalizePreferences(raw: unknown): Preferences {
  const d = DEFAULT_PREFERENCES;
  const p = isObject(raw) ? raw : {};
  const n = isObject(p.notifications) ? p.notifications : {};
  const o = isObject(p.onboarding) ? p.onboarding : {};
  return {
    theme: oneOf(THEMES, p.theme, d.theme),
    density: oneOf(DENSITIES, p.density, d.density),
    favorites: strings(p.favorites),
    notifications: {
      failures: bool(n.failures, d.notifications.failures),
      recoveries: bool(n.recoveries, d.notifications.recoveries),
      jobs: bool(n.jobs, d.notifications.jobs),
      config: bool(n.config, d.notifications.config),
    },
    updateCheck: oneOf(UPDATE_CHECKS, p.updateCheck, d.updateCheck),
    updateAsked: bool(p.updateAsked, d.updateAsked),
    onboarding: {
      completed: bool(o.completed, false),
      skipped: bool(o.skipped, false),
      ...(typeof o.step === "string" && o.step !== "" ? { step: o.step } : {}),
      done: strings(o.done),
      ...(isObject(o.choices) ? { choices: stringMap(o.choices) } : {}),
    },
    appsLayout: oneOf(APPS_LAYOUTS, p.appsLayout, d.appsLayout),
    ...(isObject(p.icons) ? { icons: iconMap(p.icons) } : {}),
  };
}

/** The icon choices this UI understands; anything else is left out. */
function iconMap(v: Record<string, unknown>): Record<string, IconChoice> {
  const out: Record<string, IconChoice> = {};
  for (const [key, raw] of Object.entries(v)) {
    if (!isObject(raw) || !(key.startsWith("project:") || key.startsWith("app:"))) continue;
    if (raw.kind === "initials") {
      out[key] = {
        kind: "initials",
        ...(typeof raw.text === "string" && raw.text ? { text: raw.text } : {}),
        ...(typeof raw.tint === "number" && raw.tint >= 1 && raw.tint <= 8 ? { tint: raw.tint } : {}),
      };
    } else if (raw.kind === "file" && typeof raw.machine === "string" && typeof raw.path === "string" && raw.machine && raw.path) {
      out[key] = { kind: "file", machine: raw.machine, path: raw.path };
    }
  }
  return out;
}

/** Why the server would refuse these preferences (400), or null. The mock uses it. */
export function preferencesProblem(p: Preferences): string | null {
  if (!THEMES.includes(p.theme)) return `theme must be one of ${THEMES.join(", ")}`;
  if (!DENSITIES.includes(p.density)) return `density must be one of ${DENSITIES.join(", ")}`;
  if (!UPDATE_CHECKS.includes(p.updateCheck)) return `updateCheck must be one of ${UPDATE_CHECKS.join(", ")}`;
  if (!APPS_LAYOUTS.includes(p.appsLayout)) return `appsLayout must be one of ${APPS_LAYOUTS.join(", ")}`;
  for (const [key, c] of Object.entries(p.icons ?? {})) {
    if (c.kind === "initials" && [...(c.text ?? "")].length > 3) return `the initials of ${key} are longer than 3 characters`;
  }
  return null;
}

/** The value of data-theme on <html>: null removes it, so the system's choice applies. */
export function themeAttribute(theme: Theme): "light" | "dark" | null {
  return theme === "system" ? null : theme;
}

/** The part of an element applyAppearance touches, so tests can pass a fake. */
export interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface Appearance {
  theme: Theme;
  density: Density;
}

/** Puts theme and density on the root element. */
export function applyAppearance(el: AttributeTarget, a: Appearance): void {
  const theme = themeAttribute(a.theme);
  if (theme) el.setAttribute("data-theme", theme);
  else el.removeAttribute("data-theme");
  el.setAttribute("data-density", a.density);
}

// The last appearance is also kept in this browser, so the next start paints
// in the right theme before the preferences arrive.
const APPEARANCE_KEY = "portplane.appearance";

export function cacheAppearance(storage: Pick<Storage, "setItem"> | undefined, a: Appearance): void {
  try {
    storage?.setItem(APPEARANCE_KEY, JSON.stringify({ theme: a.theme, density: a.density }));
  } catch {
    // storage blocked: the page starts in the system theme
  }
}

export function cachedAppearance(storage: Pick<Storage, "getItem"> | undefined): Appearance | null {
  try {
    const raw = storage?.getItem(APPEARANCE_KEY);
    if (!raw) return null;
    const p = normalizePreferences(JSON.parse(raw));
    return { theme: p.theme, density: p.density };
  } catch {
    return null;
  }
}

/** First run: show the guided setup until it is completed or skipped (plan §3.1). */
export function needsOnboarding(p: Preferences): boolean {
  return !p.onboarding.completed && !p.onboarding.skipped;
}
