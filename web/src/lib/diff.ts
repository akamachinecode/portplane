// A small line diff for setup's file review (ADR-0009: every write is shown
// first as a diff). Config files are short, so a plain LCS table is enough;
// past a size limit the changed middle shows as removed-then-added.

export type DiffLine =
  | { kind: "same"; text: string; oldNo: number; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "add"; text: string; newNo: number };

/** Runs of lines to show, and runs of unchanged lines folded away (expandable). */
export type DiffChunk = { kind: "lines"; lines: DiffLine[] } | { kind: "fold"; lines: DiffLine[] };

/** Above this many table cells (old × new lines in the changed middle), skip the LCS. */
const MAX_CELLS = 4_000_000;

/** "a\nb\n" -> ["a", "b"]; "" -> []. CRLF counts as LF. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-by-line diff of two texts. Within a changed block, removals come before additions. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: DiffLine[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: i + 1 });

  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_CELLS) {
    // lcs[i * (m + 1) + j] = LCS length of a[start+i..endA) and b[start+j..endB)
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        out.push({ kind: "same", text: a[start + i], oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        out.push({ kind: "del", text: a[start + i], oldNo: start + i + 1 });
        i++;
      } else {
        out.push({ kind: "add", text: b[start + j], newNo: start + j + 1 });
        j++;
      }
    }
  } else {
    for (let i = start; i < endA; i++) out.push({ kind: "del", text: a[i], oldNo: i + 1 });
    for (let j = start; j < endB; j++) out.push({ kind: "add", text: b[j], newNo: j + 1 });
  }

  for (let k = 0; endA + k < a.length; k++) {
    out.push({ kind: "same", text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

/**
 * Keeps `context` unchanged lines around each change and folds the rest.
 * A fold always hides at least `minFold` lines: hiding one line behind a
 * button saves nothing.
 */
export function foldContext(lines: DiffLine[], context = 3, minFold = 3): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  const push = (kind: DiffChunk["kind"], run: DiffLine[]) => {
    if (run.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (last && last.kind === kind) last.lines.push(...run);
    else chunks.push({ kind, lines: [...run] });
  };

  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "same") {
      const from = i;
      while (i < lines.length && lines[i].kind !== "same") i++;
      push("lines", lines.slice(from, i));
      continue;
    }
    const from = i;
    while (i < lines.length && lines[i].kind === "same") i++;
    const run = lines.slice(from, i);
    const keepBefore = from === 0 ? 0 : context; // after a previous change
    const keepAfter = i === lines.length ? 0 : context; // before the next change
    if (run.length - keepBefore - keepAfter < minFold) {
      push("lines", run);
      continue;
    }
    push("lines", run.slice(0, keepBefore));
    push("fold", run.slice(keepBefore, run.length - keepAfter));
    push("lines", run.slice(run.length - keepAfter));
  }
  return chunks;
}
