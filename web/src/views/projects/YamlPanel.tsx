import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ConfigProblem, ProjectConfig } from "../../api/dekit";
import { useApp } from "../../components/AppContext";
import { Icon, Spinner } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { SaveReview } from "./SaveReview";
import { digestOf } from "./TasksPanel";

// The raw YAML (plan §4.5): a plain editor with line numbers, checked
// against dekit's schema as you type, and saved through the same diff and
// reload review as every other change. A textarea keeps it dependency-free
// and fully accessible; config files are short.

export function YamlPanel({ runner, config, onSaved }: { runner: string; config: ProjectConfig; onSaved(): void }) {
  const { api } = useApp();
  const files = config.files.filter((f) => f.exists);
  const [path, setPath] = useState(files[0]?.path ?? config.file);
  const file = config.files.find((f) => f.path === path) ?? config.files[0];
  const [text, setText] = useState(file.content);
  const [problems, setProblems] = useState<ConfigProblem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => setText(file.content), [file.path, file.content]);

  // Check as you type, a moment after the last key.
  useEffect(() => {
    let live = true;
    setChecking(true);
    const t = setTimeout(() => {
      api.dekitValidate(text).then(
        (p) => live && (setProblems(p), setChecking(false)),
        () => live && setChecking(false),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [api, text]);

  const lines = useMemo(() => text.split("\n").length, [text]);
  const bad = new Set((problems ?? []).map((p) => p.line).filter(Boolean));
  const dirty = text !== file.content;
  const goTo = (line: number) => {
    const el = area.current;
    if (!el) return;
    const start = text.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(start, start + (text.split("\n")[line - 1]?.length ?? 0));
    el.scrollTop = Math.max(0, (line - 4) * 20);
  };

  return (
    <div className="yaml-panel">
      <div className="yaml-toolbar">
        {files.length > 1 && (
          <Segmented
            label="File"
            value={path}
            onChange={setPath}
            disabled={dirty}
            options={files.map((f) => ({ value: f.path, label: f.rel }))}
          />
        )}
        <span className="spacer" />
        <span className="yaml-status" role="status">
          {checking ? (
            <>
              <Spinner size={12} /> Checking…
            </>
          ) : problems && problems.length ? (
            <>
              <Icon name="warning" size={13} /> {problems.length === 1 ? "1 problem" : `${problems.length} problems`}
            </>
          ) : (
            <>
              <Icon name="checkCircle" size={13} /> Valid
            </>
          )}
        </span>
      </div>
      {dirty && files.length > 1 && <p className="field-hint">Save or discard this file's changes to switch files.</p>}
      <div className="yaml-editor">
        <div className="yaml-gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <span key={i} className={bad.has(i + 1) ? "is-bad" : undefined}>
              {i + 1}
            </span>
          ))}
        </div>
        <textarea
          id={id}
          ref={area}
          className="yaml-text mono"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          wrap="off"
          aria-label={`${file.rel} as YAML`}
          aria-invalid={problems && problems.length ? true : undefined}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              // Two spaces, never a tab character (YAML refuses tabs).
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: s, selectionEnd: en } = el;
              const next = text.slice(0, s) + "  " + text.slice(en);
              setText(next);
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            }
          }}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {problems && problems.length > 0 && (
        <ul className="yaml-problems">
          {problems.map((p, i) => (
            <li key={i}>
              {p.line ? (
                <button type="button" className="link-btn mono" onClick={() => goTo(p.line!)}>
                  line {p.line}
                </button>
              ) : null}{" "}
              {p.path && <span className="mono muted">{p.path}: </span>}
              {p.message}
            </li>
          ))}
        </ul>
      )}
      {dirty && (
        <div className="form-actions">
          <span className="form-dirty">Not saved</span>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => setText(file.content)}>
            Discard
          </button>
          <button type="button" className="btn btn-primary" disabled={!!problems?.length || checking} onClick={() => setReviewing(true)}>
            Review and save…
          </button>
        </div>
      )}
      {reviewing && (
        <SaveReview
          title={`Save ${file.rel}`}
          runner={runner}
          folder={config.root === "host" ? config.file.replace(/\/[^/]+$/, "") : config.root}
          run={(write) => api.dekitEdit({ runner, file: file.path, digests: digestOf(config, file.path), ops: [{ op: "replace", text }], write })}
          onClose={() => setReviewing(false)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
