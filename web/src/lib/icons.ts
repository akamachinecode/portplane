import type { App, MachineSnapshot, Preferences, Project } from "../api/types";

// App and project icons (ADR-0030). Each app and project shows, in order:
// the icon the user chose for it, the favicon or logo found in its folder,
// and its initials on a colour taken from its name. The user's choice lives
// in the preferences, keyed by machine and app or project; the folder's
// image is read by the agent of the machine the code is on.

/** What the user chose for one app or project. */
export type IconChoice =
  | { kind: "auto" }
  | { kind: "initials"; text?: string; tint?: number }
  | { kind: "file"; machine: string; path: string };

/** An image read from disk, ready for an <img>. */
export interface IconImage {
  path: string;
  mime: string;
  /** Base64 of the file. */
  data: string;
}

export const TINTS = 8;

/** The preferences key of a project's icon. */
export function projectIconKey(machine: string, project: Pick<Project, "name">): string {
  return `project:${machine}|${project.name}`;
}

/** The preferences key of an app's icon. */
export function appIconKey(machine: string, app: Pick<App, "id">): string {
  return `app:${machine}|${app.id}`;
}

export function iconChoice(prefs: Preferences | null | undefined, key: string): IconChoice {
  return prefs?.icons?.[key] ?? { kind: "auto" };
}

/** Words of a name: split on separators and camelCase ("myShop-api" → my, Shop, api). */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s\-_./·:()[\]]+/)
    .filter(Boolean);
}

/**
 * One or two letters for a name: the first letters of its first two words
 * ("acme-shop" → AS), or the first letter of a single word ("Repos" → R).
 * Digits count as letters ("3d-viewer" → 3V).
 */
export function initialsOf(name: string): string {
  const w = words(name).filter((x) => /[\p{L}\p{N}]/u.test(x));
  if (w.length === 0) return "?";
  const first = (s: string) => [...s].find((c) => /[\p{L}\p{N}]/u.test(c)) ?? "";
  const letters = w.length === 1 ? first(w[0]) : first(w[0]) + first(w[1]);
  return letters.toLocaleUpperCase();
}

/** A tint (1–8) for a name, the same every time. */
export function tintOf(name: string): number {
  let h = 2166136261;
  for (const c of name.toLowerCase()) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % TINTS) + 1;
}

/** Where to look for an image: the folder to start from and the folder to stop at (the checkout). */
export interface IconPlace {
  machine: string;
  dir: string;
  root?: string;
}

/** Where an app's favicon would be: its own folder, then up to its checkout. */
export function appIconPlace(ms: MachineSnapshot, app: App): IconPlace | null {
  if (!app.dir) return null;
  return { machine: ms.machine.id, dir: app.dir, root: app.checkout ?? app.repo };
}

/** Where a project's logo would be: its repository (or its main checkout's folder). */
export function projectIconPlace(ms: MachineSnapshot, project: Project): IconPlace | null {
  const main = project.worktrees.find((w) => !w.name && w.path) ?? project.worktrees.find((w) => w.path);
  const dir = project.repo ?? project.repos?.[0] ?? main?.path;
  return dir ? { machine: ms.machine.id, dir, root: dir } : null;
}

export function dataUrl(img: IconImage): string {
  return `data:${img.mime};base64,${img.data}`;
}
