import { useMemo, useState } from "react";
import type { FileChange } from "../api/types";
import { diffStats, foldContext, lineDiff, type DiffLine } from "../lib/diff";
import { relativePath } from "../lib/setup";
import { Icon } from "./Icon";

const SIGN = { same: " ", add: "+", del: "−" } as const;
const SR = { same: "", add: "added: ", del: "removed: " } as const;

function Row({ line }: { line: DiffLine }) {
  return (
    <tr className={`diff-${line.kind}`}>
      <td className="diff-ln">{line.kind === "add" ? "" : line.oldNo}</td>
      <td className="diff-ln">{line.kind === "del" ? "" : line.newNo}</td>
      <td className="diff-sign" aria-hidden="true">
        {SIGN[line.kind]}
      </td>
      <td className="diff-code">
        {SR[line.kind] && <span className="sr-only">{SR[line.kind]}</span>}
        {line.text || "​"}
      </td>
    </tr>
  );
}

/** One file: added lines green, removed red, long unchanged runs folded behind a button. */
function FileDiffBody({ file }: { file: FileChange }) {
  const lines = useMemo(() => lineDiff(file.before, file.after), [file.before, file.after]);
  const chunks = useMemo(() => foldContext(lines), [lines]);
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  return (
    <div className="diff-scroll">
      <table className="diff">
        <tbody>
          {chunks.map((c, i) =>
            c.kind === "lines" || opened.has(i) ? (
              c.lines.map((l, j) => <Row key={`${i}-${j}`} line={l} />)
            ) : (
              <tr key={i} className="diff-fold">
                <td colSpan={4}>
                  <button type="button" className="diff-fold-btn" onClick={() => setOpened(new Set(opened).add(i))}>
                    <Icon name="chevronDown" size={13} />
                    {c.lines.length === 1 ? "1 unchanged line" : `${c.lines.length} unchanged lines`}
                  </button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function FileDiff({ file, folder }: { file: FileChange; folder: string }) {
  const stats = useMemo(() => diffStats(lineDiff(file.before, file.after)), [file.before, file.after]);
  const path = relativePath(file.path, folder);
  return (
    <article className="file-diff" aria-label={path}>
      <header className="file-diff-head">
        <Icon name="file" size={14} className="file-diff-icon" />
        <span className="file-diff-path mono" title={file.path}>
          {path}
        </span>
        <span className={`tag${file.changed ? (file.created ? " tag-new" : " tag-changed") : ""}`}>
          {file.changed ? (file.created ? "new file" : "modified") : "no changes"}
        </span>
        {file.changed && (
          <span className="diff-stat">
            <span className="diff-stat-add">+{stats.added}</span>
            <span className="diff-stat-del">−{stats.removed}</span>
          </span>
        )}
      </header>
      {file.changed && <FileDiffBody file={file} />}
    </article>
  );
}
