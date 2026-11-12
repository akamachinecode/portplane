import { useEffect, useId, useMemo, useState } from "react";
import type { EditOp, ProjectConfig, TaskEntry } from "../../api/dekit";
import { useApp } from "../../components/AppContext";
import { Field } from "../../components/Controls";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu, type MenuItem } from "../../components/Menu";
import { EmptyState } from "../../components/States";
import { TaskForm } from "./TaskForm";
import { SaveReview } from "./SaveReview";

// The project tree (plan §4.5): dekit.yaml and its fragments, each with
// its folders and tasks in file order; rename, duplicate ("Duplicate as
// web-2"), move up and down. Selecting a task opens its form.

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

export function TasksPanel({ runner, config, os, selected, onSelect, onSaved }: { runner: string; config: ProjectConfig; os?: string; selected: string | null; onSelect(path: string | null): void; onSaved(): void }) {
  const { api } = useApp();
  const [naming, setNaming] = useState<{ entry: TaskEntry; mode: "rename" | "duplicate" } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const byFile = useMemo(() => config.files.map((f) => ({ file: f, tasks: config.tasks.filter((t) => t.file === f.path) })), [config]);
  const entry = config.tasks.find((t) => t.path === selected && !t.folder) ?? null;
  useEffect(() => {
    if (selected && !config.tasks.some((t) => t.path === selected)) onSelect(null);
  }, [config, selected, onSelect]);
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
    <div className={`tasks-panel${entry ? " has-task" : ""}`}>
      <nav className="task-tree" aria-label="Files and tasks">
        {byFile.map(({ file, tasks }) => (
          <section key={file.path} className="task-tree-file">
            <p className="task-tree-file-name">
              <Icon name="file" size={13} />
              <span className="mono" title={file.path}>
                {file.rel}
              </span>
              {file.at && <span className="tag">at {file.at}</span>}
              {file.role === "portplane" && <span className="tag">Portplane</span>}
              {!file.exists && <span className="tag">not created yet</span>}
            </p>
            {tasks.length === 0 ? (
              <p className="task-tree-empty muted">{file.exists ? "No tasks." : "Created when you add an app."}</p>
            ) : (
              <ul className="task-tree-list">
                {tasks.map((t, i) => {
                  const depth = t.key.replace(/\/$/, "").split("/").length - 1;
                  const items = menuFor(t, i, tasks.length);
                  return (
                    <li key={t.path} className={`task-tree-item${t.folder ? " is-folder" : ""}`} style={{ paddingLeft: depth * 14 }}>
                      {t.folder ? (
                        <span className="task-tree-folder">
                          <Icon name="folder" size={13} />
                          <span className="mono">{t.key}</span>
                        </span>
                      ) : (
                        <button type="button" className="task-tree-task" aria-current={t.path === selected ? "true" : undefined} onClick={() => onSelect(t.path)}>
                          <span className="mono">{t.key.split("/").pop()}</span>
                          {typeof t.values.label === "string" && t.values.label !== t.key.split("/").pop() && <span className="muted">{t.values.label as string}</span>}
                          {t.values.type === "job" && <span className="tag">step</span>}
                          {!t.editable && <Icon name="info" size={12} />}
                        </button>
                      )}
                      {items.length > 0 && <Menu label={`Actions for ${t.path}`} items={items} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </nav>
      <div className="task-editor">
        {entry ? (
          <>
            <header className="task-editor-head">
              <h3 className="task-editor-title mono">{entry.path}</h3>
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
            Its command, folder, environment, dependencies and how it starts and stops show here, with dekit's own help for each.
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

export function digestOf(config: ProjectConfig, file: string): Record<string, string> | undefined {
  const f = config.files.find((x) => x.path === file);
  return f?.digest ? { [file]: f.digest } : undefined;
}
