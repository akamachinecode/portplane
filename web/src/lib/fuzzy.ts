// Fuzzy matching for the command palette: the query's letters must appear in
// order (a subsequence, spaces in the query ignored, case ignored). Among the
// ways to match, the best one wins: letters in a row, at the start of a word
// or of the text score higher, and gaps cost a little.

export interface FuzzyMatch {
  score: number;
  /** Positions in the text of the matched letters, for highlighting. */
  indices: number[];
}

const MATCH = 1;
const CONSECUTIVE = 6;
const WORD_START = 8;
const TEXT_START = 10;
const CAMEL = 5;
const GAP = 0.6; // per letter skipped between two matches
const LEAD = 0.15; // per letter before the first match
const LENGTH = 0.02; // per letter of text: shorter wins a tie

const SEPARATORS = new Set([" ", "-", "_", "/", ".", ":", "@", "|", "·", "(", "#", ","]);

function bonus(text: string, j: number): number {
  if (j === 0) return TEXT_START;
  const prev = text[j - 1];
  if (SEPARATORS.has(prev)) return WORD_START;
  const ch = text[j];
  if (prev >= "a" && prev <= "z" && ch >= "A" && ch <= "Z") return CAMEL;
  return 0;
}

/** The best match of query in text, or null when its letters aren't all there in order. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (q === "") return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (n > m) return null;

  // Quick reject before the full search.
  for (let i = 0, j = 0; i < n; i++, j++) {
    j = t.indexOf(q[i], j);
    if (j < 0) return null;
  }

  // score[i][j]: best score with q[i] matched at t[j]; from[i][j]: where q[i-1] was.
  const score: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m).fill(-Infinity);
    const back = new Int32Array(m).fill(-1);
    const prev = i > 0 ? score[i - 1] : null;
    // best of prev[k] + GAP*k over k <= j-2, so a gap of (j-1-k) costs GAP*(j-1-k)
    let runBest = -Infinity;
    let runAt = -1;
    for (let j = i; j < m; j++) {
      if (prev && j >= 2) {
        const v = prev[j - 2] + GAP * (j - 2);
        if (v > runBest) {
          runBest = v;
          runAt = j - 2;
        }
      }
      if (t[j] !== q[i]) continue;
      const b = MATCH + bonus(text, j);
      if (!prev) {
        row[j] = b - LEAD * j;
        continue;
      }
      let best = -Infinity;
      let at = -1;
      if (j >= 1 && prev[j - 1] > -Infinity) {
        best = prev[j - 1] + CONSECUTIVE;
        at = j - 1;
      }
      if (runBest > -Infinity) {
        const v = runBest - GAP * (j - 1);
        if (v > best) {
          best = v;
          at = runAt;
        }
      }
      if (at < 0) continue;
      row[j] = best + b;
      back[j] = at;
    }
    score.push(row);
    from.push(back);
  }

  const last = score[n - 1];
  let end = -1;
  for (let j = 0; j < m; j++) if (last[j] > -Infinity && (end < 0 || last[j] > last[end])) end = j;
  if (end < 0) return null;

  const indices = new Array<number>(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = from[i][j];
  }
  return { score: last[end] - LENGTH * m, indices };
}

/** Splits text into runs for rendering, marking the matched letters. */
export function highlightRuns(text: string, indices: readonly number[]): Array<{ text: string; match: boolean }> {
  if (indices.length === 0) return [{ text, match: false }];
  const marked = new Set(indices);
  const runs: Array<{ text: string; match: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const match = marked.has(i);
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.match === match) lastRun.text += text[i];
    else runs.push({ text: text[i], match });
  }
  return runs;
}
