import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppsLayout as LayoutPref, Snapshot } from "../api/types";
import { actOnApp, copyWithToast } from "../components/appActions";
import { useApp } from "../components/AppContext";
import type { RowExtras } from "../components/AppRow";
import { Icon } from "../components/Icon";
import { MachineSection, ProjectGrid } from "../components/MachineSection";
import { EntryRows } from "../components/ProjectCard";
import { SkeletonCards } from "../components/Skeleton";
import { projectFoldKey, useFolds, worktreeFoldKey } from "../hooks/useFolds";
import { indexApps } from "../lib/apps";
import { foldedByDefault } from "../lib/projects";
import { EmptyState } from "../components/States";
import { ViewHeader } from "../components/ViewHeader";
import { appHref, copyableUrl, isAlive } from "../lib/apps";
import { appRoute, navigate } from "../lib/router";
import type { ListAction } from "../lib/shortcuts";
import { safeLocalStorage } from "../lib/storage";
import { summaryParts } from "../lib/summary";
import { SnapshotGate } from "../shell/SnapshotGate";
import { useShell } from "../shell/ShellContext";
import { AppsTable, projectSections } from "./apps/AppsTable";
import { AppsToolbar } from "./apps/AppsToolbar";
import { GettingStarted } from "./apps/GettingStarted";
import { HealthLine } from "./apps/HealthLine";
import {
  canAct,
  hasFilters,
  layoutApps,
  NO_FILTERS,
  pruneSelection,
  selectBy,
  selectRange,
  SORTS,
  toggleFavorite,
  toggleSelection,
  type AppEntry,
  type AppFilters,
  type AppsLayout,
  type SelectBy,
  type SortKey,
} from "./apps/model";
import { SelectionBar } from "./apps/SelectionBar";
import { isInteractive, useListKeys } from "./apps/useListKeys";
import "./AppsView.css";
import "./apps/apps.css";

// Filters and the sort survive a trip to another view; the sort also a
// reload (this browser only: it is a convenience, not a preference).
const SORT_KEY = "portplane.apps.sort";
let lastFilters: AppFilters = NO_FILTERS;

function readSort(): SortKey {
  try {
    const v = safeLocalStorage()?.getItem(SORT_KEY);
    return SORTS.some((s) => s.value === v) ? (v as SortKey) : "activity";
  } catch {
    return "activity";
  }
}

function writeSort(sort: SortKey) {
  try {
    safeLocalStorage()?.setItem(SORT_KEY, sort);
  } catch {
    // storage blocked: the sort resets on the next start
  }
}

/** Focuses a row's name, if it is rendered; false when it is not (a windowed table). */
function focusRow(key: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-app-key="${CSS.escape(key)}"] .row-label`);
  if (!el) return false;
  el.focus({ preventScroll: true });
  el.closest("li, tr")?.scrollIntoView({ block: "nearest" });
  return true;
}

/** Every dev server, by machine and project: the main view (plan §6.2). */
export function AppsView() {
  const { summary, route } = useShell();
  const { openAddMachine } = useApp();
  return (
    <>
      <ViewHeader
        title="Apps"
        summary={
          summary && (
            <span className="summary">
              {summaryParts(summary).map((p) => (
                <span key={p.tone} className={`summary-part tone-${p.tone}`}>
                  {p.text}
                </span>
              ))}
            </span>
          )
        }
      />
      <GettingStarted />
      <SnapshotGate loading={<SkeletonCards label="Connecting to Portplane…" />}>
        {(snapshot) =>
          snapshot.machines.length === 0 ? (
            <EmptyState icon="machine" title="No machines to show" />
          ) : (
            <>
              <AppsBody snapshot={snapshot} keysOn={route.view === "apps" && !route.detail} />
              <button type="button" className="add-machine" onClick={openAddMachine}>
                <span className="add-machine-icon">
                  <Icon name="plus" size={15} />
                </span>
                <span className="add-machine-text">
                  <span className="add-machine-title">Add a machine</span>
                  <span className="add-machine-hint">See the dev servers of another computer over SSH, Tailscale included.</span>
                </span>
              </button>
            </>
          )
        }
      </SnapshotGate>
    </>
  );
}

function AppsBody({ snapshot, keysOn }: { snapshot: Snapshot; keysOn: boolean }) {
  const ctx = useApp();
  const { preferences, updatePreferences } = useShell();
  const prefs = preferences.status === "ok" ? preferences.value : null;
  const favorites = prefs?.favorites;
  const favSet = useMemo(() => new Set(favorites ?? []), [favorites]);
  const mode: LayoutPref = prefs?.appsLayout ?? "cards";

  const [filters, setFiltersState] = useState<AppFilters>(lastFilters);
  const setFilters = useCallback((f: AppFilters) => {
    lastFilters = f;
    setFiltersState(f);
  }, []);
  const [sort, setSortState] = useState<SortKey>(readSort);
  const setSort = useCallback((s: SortKey) => {
    writeSort(s);
    setSortState(s);
  }, []);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const folds = useFolds();
  const filtering = hasFilters(filters);
  const computed: AppsLayout = useMemo(() => layoutApps(snapshot, favSet, filters, sort), [snapshot, favSet, filters, sort]);
  // The keyboard walks only the rows on screen: folded projects and
  // worktrees are skipped (the table and a search show everything).
  const layout: AppsLayout = useMemo(() => {
    if (filtering || mode === "table") return computed;
    const order = [...computed.pinned];
    for (const m of computed.machines) {
      const byId = indexApps(m.ms.apps);
      for (const p of m.projects) {
        if (folds.isFolded(projectFoldKey(m.ms.machine.id, p.project.runner, p.project.name), false)) continue;
        for (const w of p.worktrees) {
          if (p.multi && folds.isFolded(worktreeFoldKey(m.ms.machine.id, p.project.runner, p.project.name, w.name), foldedByDefault(w.worktree, byId))) continue;
          order.push(...w.entries);
        }
      }
    }
    return { ...computed, order };
  }, [computed, folds, filtering, mode]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const byKey = useMemo(() => new Map(layout.order.map((e) => [e.key, e])), [layout]);

  // A selected app that is filtered out or gone is no longer selected.
  useEffect(() => setSelection((s) => pruneSelection(s, layout.order)), [layout]);

  // A pinned or unpinned row moves to another section: focus follows it.
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    if (!document.activeElement?.closest(`[data-app-key="${CSS.escape(key)}"]`)) focusRow(key);
  }, [layout]);

  const pin = useCallback(
    (key: string) => {
      const entry = layoutRef.current.order.find((e) => e.key === key);
      if (document.activeElement?.closest(`[data-app-key="${CSS.escape(key)}"]`)) refocus.current = key;
      const pinned = favSet.has(key);
      void updatePreferences((p) => ({ ...p, favorites: toggleFavorite(p.favorites, key) })).then((ok) => {
        if (!ok || !pinned) return;
        ctx.toast.info(`Unpinned ${entry?.app.label ?? "the app"}`, {
          action: {
            label: "Undo",
            run: () => void updatePreferences((p) => (p.favorites.includes(key) ? p : { ...p, favorites: [...p.favorites, key] })),
          },
        });
      });
    },
    [favSet, updatePreferences, ctx.toast],
  );

  const select = useCallback((key: string, range: boolean) => {
    const from = anchor.current; // read now: the updater runs later
    const order = layoutRef.current.order;
    setSelection((s) => (range ? selectRange(s, order, from, key) : toggleSelection(s, key)));
    anchor.current = key;
    setCursor(key);
  }, []);

  // Stable handlers per row, so memoised rows only re-render when their app,
  // pin, selection or cursor changes.
  const handlers = useRef(new Map<string, { onSelect(range: boolean): void; onToggleFavorite(): void }>());
  const latest = useRef({ pin, select });
  latest.current = { pin, select };
  const handlersFor = useCallback((key: string) => {
    let h = handlers.current.get(key);
    if (!h) {
      h = { onSelect: (range) => latest.current.select(key, range), onToggleFavorite: () => latest.current.pin(key) };
      handlers.current.set(key, h);
    }
    return h;
  }, []);

  const extras = useCallback(
    (e: AppEntry): RowExtras => {
      const h = handlersFor(e.key);
      return { entryKey: e.key, favorite: e.favorite, selected: selection.has(e.key), cursor: cursor === e.key, onSelect: h.onSelect, onToggleFavorite: h.onToggleFavorite };
    },
    [selection, cursor, handlersFor],
  );

  const moveTo = useCallback((key: string) => {
    setCursor(key);
    if (!focusRow(key)) setFocusKey(key); // the table brings it on screen first
  }, []);

  useListKeys(keysOn, (a: ListAction, e: KeyboardEvent) => {
    const order = layoutRef.current.order;
    const current = cursor ? byKey.get(cursor) : undefined;
    const inList = e.target instanceof Element && !!e.target.closest("[data-app-key]");
    switch (a.kind) {
      case "move": {
        if (order.length === 0) return false;
        const i = current ? order.indexOf(current) : -1;
        const next = i < 0 ? (a.delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, i + a.delta));
        // Arrows scroll the page unless the list has focus.
        if (e.key.startsWith("Arrow") && !inList) return false;
        moveTo(order[next].key);
        return true;
      }
      case "first":
      case "last":
        if (!inList || order.length === 0) return false;
        moveTo(order[a.kind === "first" ? 0 : order.length - 1].key);
        return true;
      case "search":
        searchRef.current?.focus();
        searchRef.current?.select();
        return true;
      case "clear":
        if (selection.size === 0) return false;
        setSelection(new Set());
        return true;
    }
    if (!current) return false;
    const { app, ms } = current;
    const machine = ms.machine.id;
    switch (a.kind) {
      case "details":
        if (isInteractive(e.target)) return false; // Enter on a link or button does its own thing
        navigate(appRoute(machine, app.id));
        return true;
      case "toggle":
        if (!canAct(current)) return false;
        void actOnApp(ctx, machine, app, isAlive(app.state) ? "stop" : "start");
        return true;
      case "restart":
        if (!canAct(current) || !isAlive(app.state)) return false;
        void actOnApp(ctx, machine, app, "restart");
        return true;
      case "open": {
        const href = app.state === "on" ? appHref(app, ms.machine) : undefined;
        if (!href) {
          ctx.toast.info(`${app.label} isn't running, so there is nothing to open`);
          return true;
        }
        void ctx.pending.run(`app|${machine}|${app.id}|open`, null, () => ctx.api.open(machine, [href]));
        return true;
      }
      case "copy": {
        const url = copyableUrl(app, ms.machine, ms.tools);
        if (!url) {
          ctx.toast.info(`${app.label} has no URL to copy yet`);
          return true;
        }
        void copyWithToast(ctx, url, "the URL");
        return true;
      }
      case "select":
        select(current.key, a.range);
        return true;
      case "pin":
        pin(current.key);
        return true;
    }
    return false;
  });

  const onFocusCapture = (e: React.FocusEvent) => {
    const key = (e.target as Element).closest?.("[data-app-key]")?.getAttribute("data-app-key");
    if (key && key !== cursor) setCursor(key);
  };

  const onSelectBy = (by: SelectBy) => setSelection((s) => selectBy(s, layout.order, by));
  const setLayout = (appsLayout: LayoutPref) => void updatePreferences((p) => ({ ...p, appsLayout }));
  const multiMachine = layout.machines.length > 1;
  const selected = layout.order.filter((e) => selection.has(e.key));
  const clearFocusKey = useCallback(() => setFocusKey(null), []);

  const pinnedBlock =
    layout.pinned.length > 0 &&
    (mode === "table" ? (
      <section className="pinned" aria-labelledby="pinned-title">
        <h2 className="section-title pinned-title" id="pinned-title">
          <Icon name="starFilled" size={14} />
          Pinned
        </h2>
        <AppsTable
          caption="Pinned apps"
          sections={[{ key: "pinned", entries: layout.pinned }]}
          extras={extras}
          showMachine={multiMachine}
          place="project"
          sort={sort}
          onSort={setSort}
          focusKey={focusKey}
          onFocusDone={clearFocusKey}
        />
      </section>
    ) : (
      <section className="pinned" aria-labelledby="pinned-title">
        <h2 className="section-title pinned-title" id="pinned-title">
          <Icon name="starFilled" size={14} />
          Pinned
        </h2>
        <div className="card pinned-card">
          <EntryRows entries={layout.pinned} extras={extras} showProject showMachine={multiMachine} />
        </div>
      </section>
    ));

  return (
    <div className={`apps apps-${mode}${selection.size > 0 ? " has-selection" : ""}`} onFocusCapture={onFocusCapture}>
      <HealthLine />
      {layout.total > 0 && (
        <AppsToolbar
          snapshot={snapshot}
          order={layout.order}
          filters={filters}
          onFilters={setFilters}
          sort={sort}
          onSort={setSort}
          layout={mode}
          onLayout={setLayout}
          onSelectBy={onSelectBy}
          searchRef={searchRef}
          onSearchDown={() => layout.order[0] && moveTo(layout.order[0].key)}
        />
      )}
      {filtering && layout.order.length === 0 ? (
        <EmptyState
          icon="search"
          title="No apps match"
          action={
            <button type="button" className="btn" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          }
        >
          {filters.query.trim() ? `Nothing is called, served at or kept in a folder like “${filters.query.trim()}”` : "No app has every state, project and tag you picked"}
          {layout.total > 0 ? `, among ${layout.total} apps.` : "."}
        </EmptyState>
      ) : (
        <>
          {pinnedBlock}
          {snapshot.machines.map((ms) => {
            const group = layout.machines.find((m) => m.ms.machine.id === ms.machine.id);
            return (
              <MachineSection
                key={ms.machine.id}
                ms={ms}
                projects={group?.projects ?? []}
                filtering={filtering}
                showHeader={snapshot.machines.length > 1}
                renderProjects={(projects) =>
                  mode === "table" ? (
                    <AppsTable
                      caption={`Apps on ${ms.machine.name}`}
                      sections={projectSections(projects)}
                      extras={extras}
                      showMachine={false}
                      place={projects.some((p) => p.multi) ? "worktree" : null}
                      sort={sort}
                      onSort={setSort}
                      focusKey={focusKey}
                      onFocusDone={clearFocusKey}
                    />
                  ) : (
                    <ProjectGrid ms={ms} projects={projects} extras={extras} folds={folds} forceOpen={filtering} />
                  )
                }
              />
            );
          })}
        </>
      )}
      {selected.length > 0 && <SelectionBar selected={selected} onClear={() => setSelection(new Set())} />}
    </div>
  );
}
