import { useEffect, useMemo, type ReactNode } from "react";
import { AppRow, type RowExtras } from "../../components/AppRow";
import { Count } from "../../components/ProjectCard";
import { indexApps, projectApps } from "../../lib/apps";
import { useWindowed } from "./windowing";
import type { AppEntry, ProjectGroup, SortKey } from "./model";

// Table mode (plan §6.2): one dense row per app, under a row per project.
// Rows have one height, so a long table renders only what is on screen.

export interface TableSection {
  key: string;
  /** The group row above the apps; none for a single list (pinned). */
  title?: ReactNode;
  entries: AppEntry[];
}

type Row = { kind: "group"; key: string; title: ReactNode } | { kind: "app"; entry: AppEntry };

/** Row heights per density, as in AppsView.css (--table-row-h). */
export function tableRowHeight(): number {
  if (typeof document === "undefined") return 40;
  return document.documentElement.getAttribute("data-density") === "compact" ? 32 : 40;
}

export function AppsTable({
  caption,
  sections,
  extras,
  showMachine,
  place,
  sort,
  onSort,
  focusKey,
  onFocusDone,
}: {
  caption: string;
  sections: TableSection[];
  extras(e: AppEntry): RowExtras;
  showMachine: boolean;
  /** The project column: project and worktree, the worktree alone, or none. */
  place: "project" | "worktree" | null;
  sort: SortKey;
  onSort(sort: SortKey): void;
  /** A row the keyboard moved to: scroll it into view and focus its name. */
  focusKey: string | null;
  onFocusDone(): void;
}) {
  const rows = useMemo<Row[]>(
    () => sections.flatMap((s) => [...(s.title ? [{ kind: "group" as const, key: s.key, title: s.title }] : []), ...s.entries.map((entry) => ({ kind: "app" as const, entry }))]),
    [sections],
  );
  const rowHeight = tableRowHeight();
  const win = useWindowed(rows.length, rowHeight);
  const columns = 4 + (place ? 1 : 0) + (showMachine ? 1 : 0); // check, app, [place], [machine], address, actions

  // Bring the keyboard's row on screen (rendering it if it was windowed
  // out), then focus its name.
  const focusIndex = focusKey ? rows.findIndex((r) => r.kind === "app" && r.entry.key === focusKey) : -1;
  useEffect(() => {
    if (focusIndex < 0) return;
    win.scrollToIndex(focusIndex);
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-app-key="${CSS.escape(focusKey!)}"] .row-label`);
      if (el) {
        el.focus({ preventScroll: true });
        el.closest("tr")?.scrollIntoView({ block: "nearest" });
        onFocusDone();
      }
    });
    return () => cancelAnimationFrame(raf);
    // win.start/end: once the row is rendered, focus it
  }, [focusIndex, focusKey, win.start, win.end, win.scrollToIndex, onFocusDone]);

  const visible = rows.slice(win.start, win.end);
  return (
    <div className="apps-table-wrap">
      <table className="apps-table" aria-rowcount={rows.length + 1}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className="col-check" />
          <col className="col-app" />
          {place && <col className="col-project" />}
          {showMachine && <col className="col-machine" />}
          <col className="col-addr" />
          <col className="col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Selected</span>
            </th>
            <th scope="col" aria-sort={sort === "name" ? "ascending" : "none"}>
              <button type="button" className="th-sort" onClick={() => onSort(sort === "name" ? "activity" : "name")} title={sort === "name" ? "Sort by activity" : "Sort by name"}>
                App
                {sort === "name" && <span aria-hidden="true"> ↑</span>}
              </button>
            </th>
            {place && <th scope="col">{place === "worktree" ? "Worktree" : "Project"}</th>}
            {showMachine && <th scope="col">Machine</th>}
            <th scope="col">Address</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody ref={win.ref}>
          {win.padTop > 0 && (
            <tr className="table-pad" aria-hidden="true">
              <td colSpan={columns} style={{ height: win.padTop }} />
            </tr>
          )}
          {visible.map((r) =>
            r.kind === "group" ? (
              <tr key={`g:${r.key}`} className="table-group">
                <th scope="colgroup" colSpan={columns}>
                  {r.title}
                </th>
              </tr>
            ) : (
              <AppRow key={r.entry.key} variant="table" app={r.entry.app} ms={r.entry.ms} extras={extras(r.entry)} placeCell={place ?? undefined} showMachine={showMachine} />
            ),
          )}
          {win.padBottom > 0 && (
            <tr className="table-pad" aria-hidden="true">
              <td colSpan={columns} style={{ height: win.padBottom }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A machine's projects as table sections, each with its name and count. */
export function projectSections(projects: ProjectGroup[]): TableSection[] {
  return projects.map((p) => {
    const ms = p.worktrees[0]?.entries[0]?.ms;
    const all = ms ? projectApps(p.project, indexApps(ms.apps)) : [];
    return {
      key: p.key,
      title: (
        <span className="table-group-title">
          <span className="table-group-name">{p.project.name}</span>
          <Count apps={all} />
        </span>
      ),
      entries: p.worktrees.flatMap((w) => w.entries),
    };
  });
}
