import type { BrowserReport, FolderSuggestion, ProxyOptions } from "../../api/tools";
import { DEFAULT_PROXY, NO_PASSWORD_PROXY } from "../../api/tools";
import type { Proposal } from "../../api/types";

// The steps' pure rules, apart from their components so they can be tested.

export type ProxyMode = "service" | "unprivileged";

/** Package managers the included apps need that this computer lacks. */
export function missingManagers(proposals: Proposal[], managers: Record<string, string> | undefined, skip: (task: string) => boolean): string[] {
  if (!managers) return [];
  const need = new Set<string>();
  for (const p of proposals) for (const a of p.apps) if (!skip(a.task) && a.status !== "manual" && a.packageManager) need.add(a.packageManager);
  return [...need].filter((pm) => managers[pm] === "").sort();
}

export interface FolderRow {
  path: string;
  repos?: number;
  checked: boolean;
}

/** The rows: folders already watched (ticked), then suggestions; the busiest suggestion is ticked on a first run. */
export function folderRows(saved: string[], suggestions: FolderSuggestion[]): FolderRow[] {
  const rows: FolderRow[] = saved.map((path) => ({ path, checked: true, repos: suggestions.find((s) => s.path === path)?.repos }));
  const best = saved.length === 0 ? [...suggestions].sort((a, b) => b.repos - a.repos)[0]?.path : undefined;
  for (const s of suggestions) {
    if (!saved.includes(s.path)) rows.push({ path: s.path, repos: s.repos, checked: s.path === best });
  }
  return rows;
}

/** The options a form state stands for. */
export function proxyOptionsFor(mode: ProxyMode, adv: Advanced): ProxyOptions {
  const base = mode === "service" ? DEFAULT_PROXY : NO_PASSWORD_PROXY;
  const tld = adv.tld.trim().replace(/^\./, "").toLowerCase() || "localhost";
  const o: ProxyOptions = { ...base, tlds: [tld], wildcard: adv.wildcard, https: !adv.httpOnly };
  if (!adv.httpOnly && adv.cert.trim() && adv.key.trim()) {
    o.certPath = adv.cert.trim();
    o.keyPath = adv.key.trim();
  }
  return o;
}

export interface Advanced {
  tld: string;
  wildcard: boolean;
  httpOnly: boolean;
  cert: string;
  key: string;
}

const NEEDS = new Set(["missing", "outdated", "unknown"]);

/** Whether some profile still needs the CA. */
export function browsersNeedAction(r: BrowserReport): boolean {
  return r.browsers.some((b) => b.profiles.some((p) => NEEDS.has(p.status)));
}

