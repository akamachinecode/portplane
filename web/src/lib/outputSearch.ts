import type { AnsiLine, AnsiStyle } from "./ansi";

// Search in the Output panel: plain substring matches, ignoring case, and
// the styled spans of a line cut at the matches so they can be marked.

export interface Match {
  line: number;
  start: number;
  end: number;
}

/** Every match of query in lines, in reading order. Matches never overlap. */
export function findMatches(lines: string[], query: string): Match[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const out: Match[] = [];
  lines.forEach((text, line) => {
    // Lower-casing can change a string's length (İ); search as-is then.
    const lower = text.toLowerCase();
    const folded = lower.length === text.length;
    const hay = folded ? lower : text;
    const n = folded ? needle : query;
    for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length)) {
      out.push({ line, start: i, end: i + n.length });
    }
  });
  return out;
}

/** Moves through matches, wrapping at both ends. -1 when there are none. */
export function stepMatch(current: number, count: number, delta: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0 || current >= count) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** "3 of 12", "No matches" or "" with no query. */
export function matchLabel(current: number, count: number, query: string): string {
  if (!query) return "";
  if (count === 0) return "No matches";
  return `${current < 0 ? 0 : current + 1} of ${count}`;
}

export interface Segment {
  text: string;
  style: AnsiStyle;
  /** The index of the match this piece belongs to, in the whole list. */
  match?: number;
}

/**
 * Cuts a line's spans at the matches that fall in it. ranges are this line's
 * matches with their index in the whole list, in order.
 */
export function segmentLine(spans: AnsiLine, ranges: { start: number; end: number; index: number }[]): Segment[] {
  if (ranges.length === 0) return spans;
  const out: Segment[] = [];
  let pos = 0; // offset of the current span in the line
  let r = 0;
  for (const span of spans) {
    const end = pos + span.text.length;
    let at = pos;
    while (at < end) {
      while (r < ranges.length && ranges[r].end <= at) r++;
      const range = ranges[r];
      if (!range || range.start >= end) {
        out.push({ text: span.text.slice(at - pos), style: span.style });
        break;
      }
      if (range.start > at) {
        out.push({ text: span.text.slice(at - pos, range.start - pos), style: span.style });
        at = range.start;
      }
      const stop = Math.min(range.end, end);
      out.push({ text: span.text.slice(at - pos, stop - pos), style: span.style, match: range.index });
      at = stop;
    }
    pos = end;
  }
  return out;
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Ctrl+F (⌘F on macOS): find in the output instead of the whole page. */
export function isFindShortcut(e: KeyLike, mac: boolean): boolean {
  if (e.altKey || e.shiftKey) return false;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && e.key.toLowerCase() === "f";
}
