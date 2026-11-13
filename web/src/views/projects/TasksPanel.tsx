import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { EditOp, ProjectConfig, TaskEntry } from "../../api/dekit";
import { useApp } from "../../components/AppContext";
import { useScopedMachine } from "../../components/MachineScope";
import { Field } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu, type MenuItem } from "../../components/Menu";
import { EmptyState } from "../../components/States";
import { TaskForm } from "./TaskForm";
import { SaveReview } from "./SaveReview";

// The project tree (plan §4.5): the file's settings, then dekit.yaml and its
// fragments, each with its folders and tasks in file order; rename,
// duplicate ("Duplicate as web-2"), move up and down. Selecting a task
// opens its form. A folder that holds one worktree's tasks shows the
// worktree's name and starts folded (ADR-0032).

/** The tree's entry for the file's own settings (defaults, kernel, hooks…). */
export const SETTINGS = "\u0000settings";

function nextName(key: string, taken: Set<string>): string {
  const m = /^(.*?)-(\d+)$/.exec(key);
  const base = m ? m[1] : key;
  for (let n = m ? Number(m[2]) + 1 : 2; ; n++) {
    const k = `${base}-${n}`;
    if (!taken.has(k)) return k;
  }
}

type Pending = { title: string; file: string; ops: EditOp[]; select?: string };

function NameDialog({ title, label, initial, taken, onClose, onSubmit }: { title: string; label: string; initial: string; taken: Set<string>; onClose(): void; onSubmit(name: string): void }) {
  const [name, setName] = useState(initial);
  const id = useId();
  const v = name.trim();
  const error = !v ? "Enter a name." : /[\s*?[\]{}:]/.test(v) || v.startsWith("/") || v.endsWith("/") ? "Use letters, digits, - and / between parts." : taken.has(v) ? `${v} already exists.` : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!!error || v === initial} onClick={() => onSubmit(v)}>
            Review…
          </button>
        </>
      }
    >
      <Field label={label} htmlFor={id} error={v !== initial ? error : null} hint="Tasks that need it are not renamed with it: check their deps.">
        <input
          id={id}
          className="input mono"
          value={name}
          data-autofocus
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !error && v !== initial) onSubmit(v);
          }}
        />
      </Field>
    </Dialog>
  );
}

/** A task or a folder entry that holds one of these tasks (a project's own, on its page). */
export function inTasks(only: ReadonlySet<string> | undefined, t: Pick<TaskEntry, "path" | "folder">): boolean {
  if (!only) return true;
  if (only.has(t.path)) return true;
  const prefix = t.path.replace(/\/$/, "") + "/";
  return !!t.folder && [...only].some((x) => x.startsWith(prefix));
}

export function TasksPanel({
  runner,
  config,
  os,
  selected,
  onSelect,
  onSaved,
  only,
  settings,
}: {
  runner: string;
  config: ProjectConfig;
  os?: string;
  selected: string | null;
  onSelect(path: string | null): void;
  onSaved(): void;
  /** Show only these task paths (and the folder entries above them): one project's, on its page. */
  only?: ReadonlySet<string>;
  /** The file's settings, shown when the tree's Settings entry is chosen. */
  settings?: ReactNode;
}) {
  const { api } = useApp();
  const ms = useScopedMachine();
  const [naming, setNaming] = useState<{ entry: TaskEntry; mode: "rename" | "duplicate" } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const byFile = useMemo(
    () =>
      config.files
        .map((f) => ({ file: f, tasks: config.tasks.filter((t) => t.file === f.path && inTasks(only, t)) }))
        .filter((g) => !only || g.tasks.length > 0),
    [config, only],
  );
  const entry = config.tasks.find((t) => t.path === selected && !t.folder) ?? null;
  useEffect(() => {
    if (selected && selected !== SETTINGS && !config.tasks.some((t) => t.path === selected)) onSelect(null);
  }, [config, selected, onSelect]);

  // A folder (or group) that holds one linked worktree's tasks: its name and branch.
  const apps = useMemo(() => (ms?.apps ?? []).filter((a) => a.runner === runner), [ms, runner]);
  // Worked out once per folder until the apps change (it scans every app of the runner).
  const worktreeFor = useMemo(() => {
    const known = new Map<string, { name: string; branch?: string } | undefined>();
    return (path: string) => {
      if (!known.has(path)) {
        const prefix = path.replace(/\/$/, "") + "/";
        const under = apps.filter((a) => a.task.startsWith(prefix));
        const names = new Set(under.map((a) => a.worktree ?? ""));
        known.set(path, under.length && names.size === 1 && under[0].worktree ? { name: under[0].worktree, branch: under[0].branch } : undefined);
      }
      return known.get(path);
    };
  }, [apps]);
  // What the user folded or opened, by folder; the rest follows the default.
  const [foldChoice, setFoldChoice] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // Worktree folders start folded, unless the open task is inside.
  const isFolded = (path: string) => {
    const chosen = foldChoice.get(path);
    if (chosen !== undefined) return chosen;
    const prefix = path.replace(/\/$/, "") + "/";
    return !!worktreeFor(path) && !(selected && selected.startsWith(prefix));
  };
  const toggleFold = (path: string) => {
    const now = isFolded(path);
    setFoldChoice((m) => new Map(m).set(path, !now));
  };
  const keysIn = (file: string) => new Set(config.tasks.filter((t) => t.file === file).map((t) => t.key));

  const move = (t: TaskEntry, dir: -1 | 1) => {
    const siblings = config.tasks.filter((x) => x.file === t.file);
    const i = siblings.indexOf(t);
    const other = siblings[i + dir];
    if (!other) return;
    setPending({ title: `Move ${t.path} ${dir < 0 ? "up" : "down"}`, file: t.file, ops: [{ op: "move", path: ["tasks", t.key], ...(dir < 0 ? { before: other.key } : { after: other.key }) }] });
  };

  const menuFor = (t: TaskEntry, i: number, count: number): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!t.editable) return items;
    items.push({ label: "Rename…", icon: "pencil", onSelect: () => setNaming({ entry: t, mode: "rename" }) });
    if (!t.folder) items.push({ label: `Duplicate as ${nextName(t.key, keysIn(t.file))}…`, icon: "copy", onSelect: () => setNaming({ entry: t, mode: "duplicate" }) });
    if (i > 0) items.push({ label: "Move up", icon: "arrowUp", onSelect: () => move(t, -1) });
    if (i < count - 1) items.push({ label: "Move down", icon: "arrowDown", onSelect: () => move(t, 1) });
    items.push({ label: t.folder ? "Delete folder entry" : "Delete from the file", icon: "trash", onSelect: () => setPending({ title: `Delete ${t.path}`, file: t.file, ops: [{ op: "delete", path: ["tasks", t.key] }] }) });
    return items;
  };

  return (
    <div className={`tasks-panel${entry || (selected === SETTINGS && settings) ? " has-task" : ""}`}>
      <nav className="task-tree" aria-label="Files and tasks">
        {settings && (
          <button type="button" className="task-tree-task task-tree-settings" aria-current={selected === SETTINGS ? "true" : undefined} onClick={() => onSelect(SETTINGS)}>
            <Icon name="gear" size={14} />
            <span>Settings</span>
          </button>
        )}
        {byFile.map(({ file, tasks }) => {
          const own = tasks.filter((t) => !t.folder);
          const allLocked = own.length > 0 && own.every((t) => !t.editable);
          // Folder entries above each task, to hide what a folded folder holds.
          const rows = withGroups(tasks);
          const folders = rows.filter((t) => t.folder);
          const hiddenBy = (t: TaskEntry) => folders.find((f) => f !== t && t.path.startsWith(f.path.replace(/\/$/, "") + "/") && isFolded(f.path));
          const shownTasks = rows.filter((t) => !hiddenBy(t));
          const indexOf = new Map(tasks.map((t, i) => [t, i]));
          return (
            <section key={file.path} className="task-tree-file">
              <p className="task-tree-file-name" title={file.path}>
                <Icon name="file" size={13} />
                <span className="mono">{file.rel}</span>
                {file.at && <span className="tag">at {file.at}</span>}
                {!file.exists && <span className="tag">not created yet</span>}
                {(allLocked || !file.editable) && file.exists && <span className="tag">read-only</span>}
              </p>
              {tasks.length === 0 ? (
                <p className="task-tree-empty muted">{file.exists ? "No tasks." : "Created when you add an app."}</p>
              ) : (
                <ul className="task-tree-list">
                  {shownTasks.map((t) => {
                    const i = indexOf.get(t) ?? -1;
                    const depth = folders.filter((f) => f !== t && t.path.startsWith(f.path.replace(/\/$/, "") + "/")).length;
                    const items = i < 0 ? [] : menuFor(t, i, tasks.length);
                    const parentFolder = folders.filter((f) => f !== t && t.key.startsWith(f.key.replace(/\/$/, "") + "/")).sort((a, b) => b.key.length - a.key.length)[0];
                    const leaf = t.key.replace(/\/$/, "").slice(parentFolder ? parentFolder.key.replace(/\/$/, "").length + 1 : 0);
                    const wt = t.folder ? worktreeFor(t.path) : undefined;
                    const label = typeof t.values.label === "string" ? (t.values.label as string) : "";
                    const name = t.key.split("/").pop() ?? t.key;
                    return (
                      <li key={t.path} className={`task-tree-item${t.folder ? " is-folder" : ""}`} style={{ paddingLeft: depth * 14 }}>
                        {t.folder ? (
                          <button type="button" className="task-tree-folder" aria-expanded={!isFolded(t.path)} title={wt?.branch ? `${t.key} (${wt.branch})` : t.key} onClick={() => toggleFold(t.path)}>
                            <Icon name="chevronRight" size={12} className="task-tree-chevron" />
                            <Icon name={wt ? "branch" : "folder"} size={13} />
                            <span className={wt ? undefined : "mono"}>{wt ? wt.name : leaf}</span>
                          </button>
                        ) : (
                          <button type="button" className="task-tree-task" aria-current={t.path === selected ? "true" : undefined} title={label && label !== name ? `${t.path} (${label})` : t.path} onClick={() => onSelect(t.path)}>
                            <span className="mono">{leaf}</span>
                            {label && !label.startsWith(name) && <span className="muted">{label}</span>}
                            {t.values.type === "job" && <span className="tag">step</span>}
                            {!t.editable && !allLocked && (
                              <span className="task-tree-lock" title={t.problem ?? "Read-only here"}>
                                <Icon name="lock" size={12} />
                                <span className="sr-only">read-only</span>
                              </span>
                            )}
                          </button>
                        )}
                        {items.length > 0 && <Menu label={`Actions for ${t.path}`} items={items} />}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
      <div className="task-editor">
        {selected === SETTINGS && settings ? (
          <>
            <header className="task-editor-head">
              <h3 className="task-editor-title">Settings</h3>
              <button type="button" className="btn btn-sm btn-ghost task-editor-back" onClick={() => onSelect(null)}>
                <Icon name="chevronLeft" size={13} />
                All tasks
              </button>
            </header>
            {settings}
          </>
        ) : entry ? (
          <>
            <header className="task-editor-head">
              <h3 className="task-editor-title mono" title={entry.path}>
                {entry.path}
              </h3>
              <button type="button" className="btn btn-sm btn-ghost task-editor-back" onClick={() => onSelect(null)}>
                <Icon name="chevronLeft" size={13} />
                All tasks
              </button>
              <IconButton icon="close" label="Close the task" onClick={() => onSelect(null)} />
            </header>
            <TaskForm key={entry.path} runner={runner} config={config} entry={entry} os={os} onSaved={onSaved} />
          </>
        ) : (
          <EmptyState icon="pencil" title="Choose a task">
            Choose a task to see and change how it runs.
          </EmptyState>
        )}
      </div>
      {naming && (
        <NameDialog
          title={naming.mode === "rename" ? `Rename ${naming.entry.key}` : `Duplicate ${naming.entry.key}`}
          label={naming.mode === "rename" ? "New name" : "Name of the copy"}
          initial={naming.mode === "rename" ? naming.entry.key : nextName(naming.entry.key, keysIn(naming.entry.file))}
          taken={keysIn(naming.entry.file)}
          onClose={() => setNaming(null)}
          onSubmit={(name) => {
            const e = naming.entry;
            setNaming(null);
            if (naming.mode === "rename") setPending({ title: `Rename ${e.key} to ${name}`, file: e.file, ops: [{ op: "rename", path: ["tasks", e.key], to: name }], select: e.path.replace(new RegExp(`${e.key}$`), name) });
            else setPending({ title: `Duplicate ${e.key} as ${name}`, file: e.file, ops: [{ op: "insert", path: ["tasks"], key: name, value: e.values, after: e.key }], select: e.path.replace(new RegExp(`${e.key}$`), name) });
          }}
        />
      )}
      {pending && (
        <SaveReview
          title={pending.title}
          runner={runner}
          folder={config.root === "host" ? config.file.replace(/\/[^/]+$/, "") : config.root}
          run={(write) => api.dekitEdit({ runner, file: pending.file, digests: digestOf(config, pending.file), ops: pending.ops, write })}
          onClose={() => setPending(null)}
          onSaved={() => {
            if (pending.select) onSelect(pending.select);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

/** A row of the tree that groups tasks sharing a prefix ("blog/" of "blog/site") with no folder entry of its own. */
type TreeRow = TaskEntry & { group?: true };

/**
 * The file's entries with a group row above tasks whose names share a
 * prefix but have no folder entry, so the tree shows "blog" once and then
 * "site" and "studio", never "blog/site" cut short.
 */
export function withGroups(tasks: TaskEntry[]): TreeRow[] {
  const folderKeys = new Set(tasks.filter((t) => t.folder).map((t) => t.key.replace(/\/$/, "")));
  const out: TreeRow[] = [];
  const made = new Set<string>();
  for (const t of tasks) {
    const key = t.key.replace(/\/$/, "");
    const i = key.lastIndexOf("/");
    const prefix = i < 0 ? "" : key.slice(0, i);
    if (!t.folder && prefix && !folderKeys.has(prefix) && !made.has(prefix)) {
      made.add(prefix);
      const path = t.path.slice(0, t.path.length - (key.length - i));
      out.push({ path, key: `${prefix}/`, file: t.file, folder: true, line: t.line, values: {}, editable: false, group: true });
    }
    out.push(t);
  }
  return out;
}

export function digestOf(config: ProjectConfig, file: string): Record<string, string> | undefined {
  const f = config.files.find((x) => x.path === file);
  return f?.digest ? { [file]: f.digest } : undefined;
}
