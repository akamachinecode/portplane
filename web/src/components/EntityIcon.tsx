import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { Api } from "../api/client";
import type { State } from "../api/types";
import { dataUrl, initialsOf, type IconChoice, type IconPlace } from "../lib/icons";
import { useApp } from "./AppContext";

// The icon of an app or a project (ADR-0030): the user's choice, else the
// favicon or logo found in its folder, else its initials on a colour from
// its name. Images are read once per session and kept here.

const cache = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();
let version = 0;

/** Forgets every image read, so icons show what is on disk now (after the user picks one). */
export function invalidateIcons(): void {
  cache.clear();
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function load(api: Api, choice: IconChoice, place: IconPlace | null): Promise<string | null> | null {
  if (choice.kind === "initials") return null;
  const key = choice.kind === "file" ? `file|${choice.machine}|${choice.path}` : place ? `find|${place.machine}|${place.dir}|${place.root ?? ""}` : null;
  if (!key) return null;
  let p = cache.get(key);
  if (!p) {
    const read =
      choice.kind === "file"
        ? api.forMachine(choice.machine).iconFile(choice.path)
        : api.forMachine(place!.machine).iconFind(place!.dir, place!.root);
    // Any failure (an older agent, a machine offline, a file gone) shows the initials.
    p = read.then((img) => (img ? dataUrl(img) : null)).catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** The image to show for a choice and a place, or null for the initials (while it loads too). */
export function useIconImage(choice: IconChoice, place: IconPlace | null, fallback?: { choice: IconChoice; place: IconPlace | null }): string | null {
  const { api } = useApp();
  const v = useSyncExternalStore(subscribe, () => version);
  const [src, setSrc] = useState<string | null>(null);
  const key = JSON.stringify([choice, place, fallback ?? null, v]);
  useEffect(() => {
    let live = true;
    const first = load(api, choice, place);
    const second = () => (fallback ? load(api, fallback.choice, fallback.place) : null);
    void (async () => {
      let url = first ? await first : null;
      if (!url && choice.kind === "auto") {
        const f = second();
        url = f ? await f : null;
      }
      if (live) setSrc(url);
    })();
    return () => {
      live = false;
    };
    // key covers choice, place, fallback and the cache's version
  }, [api, key]);
  return src;
}

/**
 * The letters and colour when there is no image: the user's initials for
 * this one; else, for an app, its project's (an app without a favicon shows
 * its project's icon); else its own name's. The colour is the one the user
 * picked, else none (0, neutral grey): colour in a list means state, so an
 * icon only has one when someone chose it (ADR-0032).
 */
export function initialsFor(name: string, choice: IconChoice, fallback?: { choice: IconChoice; name?: string }): { letters: string; tint: number } {
  if (choice.kind === "initials") return { letters: choice.text || initialsOf(name), tint: choice.tint || 0 };
  if (choice.kind === "auto" && fallback?.name) {
    const f = fallback.choice;
    const n = fallback.name;
    return f.kind === "initials" ? { letters: f.text || initialsOf(n), tint: f.tint || 0 } : { letters: initialsOf(n), tint: 0 };
  }
  return { letters: initialsOf(name), tint: 0 };
}

export interface EntityIconProps {
  name: string;
  choice: IconChoice;
  /** Where its own favicon would be. */
  place: IconPlace | null;
  /** What to show when its folder has none: its project's icon, for an app. */
  fallback?: { choice: IconChoice; place: IconPlace | null; name?: string };
  size?: number;
  /** A small state dot on the corner. */
  state?: State;
  className?: string;
}

/** An app's or a project's icon, square with rounded corners. Decorative: the name is always next to it. */
export function EntityIcon({ name, choice, place, fallback, size = 20, state, className }: EntityIconProps) {
  const src = useIconImage(choice, place, fallback);
  const { letters, tint } = initialsFor(name, choice, fallback);
  const vars: Record<string, string> = { "--icon-size": `${size}px` };
  if (tint) vars["--icon-tint"] = `var(--tint-${tint})`;
  const style = vars as CSSProperties;
  return (
    <span className={`entity-icon${src ? " has-image" : ""}${className ? ` ${className}` : ""}`} style={style} aria-hidden="true">
      {src ? <img src={src} alt="" width={size} height={size} draggable={false} /> : <span className="entity-initials">{letters}</span>}
      {state && <span className={`entity-state dot dot-${state}`} />}
    </span>
  );
}
