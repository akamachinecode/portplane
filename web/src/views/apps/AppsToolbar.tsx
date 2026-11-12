import { useMemo, type RefObject } from "react";
import type { AppsLayout as LayoutPref, Snapshot } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { filterOptions, hasFilters, NO_FILTERS, SORTS, stateFilter, type AppEntry, type AppFilters, type SelectBy, type SortKey, type StateFilter } from "./model";
import { PopMenu, type PopSection } from "./PopMenu";

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

const LAYOUTS = [
  { value: "cards" as LayoutPref, label: "List", icon: "rows" as const },
  { value: "table" as LayoutPref, label: "Table", icon: "table" as const },
];

/** Search, filters, "Select…", sort and the layout switch, above the apps. */
export function AppsToolbar({
  snapshot,
  order,
  filters,
  onFilters,
  sort,
  onSort,
  layout,
  onLayout,
  onSelectBy,
  searchRef,
  onSearchDown,
}: {
  snapshot: Snapshot;
  order: AppEntry[];
  filters: AppFilters;
  onFilters(f: AppFilters): void;
  sort: SortKey;
  onSort(s: SortKey): void;
  layout: LayoutPref;
  onLayout(l: LayoutPref): void;
  onSelectBy(by: SelectBy): void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** ↓ in the search field: on to the first result. */
  onSearchDown(): void;
}) {
  const options = useMemo(() => filterOptions(snapshot), [snapshot]);
  const set = (patch: Partial<AppFilters>) => onFilters({ ...filters, ...patch });
  const check = (values: string[], selected: string[], key: keyof Omit<AppFilters, "query">, list: Array<{ value: string; label: string; count: number }>): PopSection => ({
    items: list.map((o) => ({ kind: "check", label: o.label, count: o.count, checked: selected.includes(o.value), onToggle: () => set({ [key]: toggle(values, o.value) } as Partial<AppFilters>) })),
  });
  const countLabel = (label: string, n: number) => (
    <>
      <span>{label}</span>
      {n > 0 && <span className="popmenu-badge">{n}</span>}
    </>
  );

  // "Select…" counts what is shown now.
  const shownBy = (pred: (e: AppEntry) => boolean) => order.filter(pred).length;
  const selectSections: PopSection[] = [
    {
      items: [{ kind: "action", label: "All shown", hint: String(order.length), disabled: order.length === 0, onSelect: () => onSelectBy({ kind: "all" }) }],
    },
    {
      title: "By state",
      items: options.states
        .map((s) => ({ ...s, shown: shownBy((e) => s.value === stateFilter(e.app.state)) }))
        .filter((s) => s.shown > 0)
        .map((s) => ({ kind: "action" as const, label: s.label, hint: String(s.shown), onSelect: () => onSelectBy({ kind: "state", state: s.value as StateFilter }) })),
    },
    {
      title: "By project",
      items: options.projects
        .map((p) => ({ ...p, shown: shownBy((e) => `${e.ms.machine.id}|${e.app.project}` === p.value) }))
        .filter((p) => p.shown > 0)
        .map((p) => ({ kind: "action" as const, label: p.label, hint: String(p.shown), onSelect: () => onSelectBy({ kind: "project", project: p.value }) })),
    },
    {
      title: "By tag",
      items: options.tags
        .map((t) => ({ ...t, shown: shownBy((e) => (e.app.tags ?? []).includes(t.value)) }))
        .filter((t) => t.shown > 0)
        .map((t) => ({ kind: "action" as const, label: t.label, hint: String(t.shown), onSelect: () => onSelectBy({ kind: "tag", tag: t.value }) })),
    },
  ];

  const sortLabel = SORTS.find((s) => s.value === sort)?.label ?? "Activity";
  return (
    <div className="apps-toolbar" role="search">
      <label className="apps-search">
        <Icon name="search" size={15} className="apps-search-icon" />
        <span className="sr-only">Search apps</span>
        <input
          ref={searchRef}
          type="search"
          className="input apps-search-input"
          placeholder="Search by name, URL or folder"
          value={filters.query}
          spellCheck={false}
          autoComplete="off"
          aria-keyshortcuts="/"
          onChange={(e) => set({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filters.query) {
              e.preventDefault();
              e.stopPropagation();
              set({ query: "" });
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onSearchDown();
            }
          }}
        />
        <kbd className="kbd apps-search-kbd" aria-hidden="true">
          /
        </kbd>
      </label>
      <div className="apps-filters" role="group" aria-label="Filters">
        <PopMenu label="Filter by state" button={countLabel("State", filters.states.length)} active={filters.states.length > 0} sections={[check(filters.states, filters.states, "states", options.states)]} />
        {options.machines.length > 1 && (
          <PopMenu label="Filter by machine" button={countLabel("Machine", filters.machines.length)} active={filters.machines.length > 0} sections={[check(filters.machines, filters.machines, "machines", options.machines)]} />
        )}
        <PopMenu
          label="Filter by project"
          button={countLabel("Project", filters.projects.length)}
          active={filters.projects.length > 0}
          sections={[check(filters.projects, filters.projects, "projects", options.projects)]}
          empty="No projects yet."
        />
        {options.tags.length > 0 && (
          <PopMenu label="Filter by tag" button={countLabel("Tag", filters.tags.length)} active={filters.tags.length > 0} sections={[check(filters.tags, filters.tags, "tags", options.tags)]} />
        )}
        {hasFilters(filters) && (
          <button type="button" className="btn btn-sm btn-ghost apps-clear" onClick={() => onFilters(NO_FILTERS)}>
            <Icon name="close" size={13} />
            Clear filters
          </button>
        )}
      </div>
      <span className="spacer" />
      <div className="apps-view-controls">
        <PopMenu label="Select apps" button={<span>Select</span>} buttonTitle="Select apps by state, project or tag" sections={selectSections} align="end" />
        <PopMenu
          label="Sort apps"
          button={
            <>
              <Icon name="sort" size={14} />
              <span>{sortLabel}</span>
            </>
          }
          buttonTitle="Sort the apps"
          align="end"
          sections={[{ items: SORTS.map((s) => ({ kind: "radio", label: s.label, description: s.description, checked: s.value === sort, onSelect: () => onSort(s.value) })) }]}
        />
        <Segmented label="Show apps as" value={layout} options={LAYOUTS} onChange={onLayout} />
      </div>
    </div>
  );
}

