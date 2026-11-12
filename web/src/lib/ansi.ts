// Terminal colour codes for the Output panel (ADR-0021). The agent keeps
// only SGR codes (colour and style) in a task's screen; this parser reads
// those into styled spans and drops anything else, so text is only ever
// rendered as text (React escapes it) and styles only ever come from numbers.

/** An index into the 256-colour palette, or a 24-bit colour. */
export type AnsiColor = number | readonly [number, number, number];

export interface AnsiStyle {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

export type AnsiLine = AnsiSpan[];

const ESC = "\x1b";

/**
 * Splits text into lines of styled spans. Styles carry over from one line to
 * the next, as in a terminal. Every escape sequence other than SGR, and every
 * control character other than a tab, is dropped.
 */
export function parseAnsi(text: string): AnsiLine[] {
  const lines: AnsiLine[] = [];
  let line: AnsiLine = [];
  let style: AnsiStyle = {};
  let run = "";
  const flush = () => {
    if (run) line.push({ text: run, style });
    run = "";
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const code = c.charCodeAt(0);
    if (c === ESC) {
      const seq = readEscape(text, i);
      if (seq.sgr !== undefined) {
        const next = applySgr(style, seq.sgr);
        if (!sameStyle(next, style)) {
          flush();
          style = next;
        }
      }
      i = seq.end;
    } else if (c === "\n") {
      flush();
      lines.push(line);
      line = [];
      i++;
    } else if (c === "\t" || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))) {
      run += c;
      i++;
    } else {
      i++; // "\r", bells, C1 controls…
    }
  }
  flush();
  lines.push(line);
  return lines;
}

/** Where the escape sequence at text[start] ends, and its SGR parameters if it is one. */
function readEscape(text: string, start: number): { end: number; sgr?: string } {
  let i = start + 1;
  if (i >= text.length) return { end: i };
  const kind = text[i];
  const at = (j: number) => text.charCodeAt(j);
  if (kind === "[") {
    i++;
    const paramsStart = i;
    while (i < text.length && at(i) >= 0x30 && at(i) <= 0x3f) i++;
    const params = text.slice(paramsStart, i);
    const intermediates = i;
    while (i < text.length && at(i) >= 0x20 && at(i) <= 0x2f) i++;
    if (i >= text.length) return { end: i };
    const final = at(i);
    if (final < 0x40 || final > 0x7e) return { end: i }; // malformed: keep what follows
    const sgr = text[i] === "m" && i === intermediates && /^[0-9;:]*$/.test(params) ? params : undefined;
    return { end: i + 1, sgr };
  }
  if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
    // A string up to BEL or ST; one left open ends with its line.
    for (let j = i + 1; j < text.length; j++) {
      const c = text[j];
      if (c === "\x07") return { end: j + 1 };
      if (c === "\n") return { end: j };
      if (c === ESC) return { end: text[j + 1] === "\\" ? j + 2 : j };
    }
    return { end: text.length };
  }
  while (i < text.length && at(i) >= 0x20 && at(i) <= 0x2f) i++;
  if (i < text.length && at(i) >= 0x30 && at(i) <= 0x7e) return { end: i + 1 };
  return { end: i };
}

const BASIC: Record<number, Partial<AnsiStyle>> = {
  1: { bold: true },
  2: { dim: true },
  3: { italic: true },
  4: { underline: true },
  7: { inverse: true },
  9: { strike: true },
  21: { underline: true },
  22: { bold: false, dim: false },
  23: { italic: false },
  24: { underline: false },
  27: { inverse: false },
  29: { strike: false },
  39: { fg: undefined },
  49: { bg: undefined },
};

/** The style after one SGR sequence's parameters ("1;31", "38;5;208", "38:2::0:0:0"…). */
export function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const parts = params === "" ? ["0"] : params.split(";");
  let s: AnsiStyle = { ...style };
  for (let i = 0; i < parts.length; i++) {
    const sub = parts[i].split(":");
    const n = toInt(sub[0]);
    if (n === undefined) continue;
    if (n === 38 || n === 48 || n === 58) {
      let color: AnsiColor | undefined;
      if (sub.length > 1) {
        const mode = toInt(sub[1]);
        if (mode === 5) color = paletteIndex(sub[2]);
        // 38:2:<colour space>:r:g:b, or 38:2:r:g:b without the colour space
        else if (mode === 2) color = rgb(...(sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5)));
      } else {
        const mode = toInt(parts[i + 1]);
        if (mode === 5) {
          color = paletteIndex(parts[i + 2]);
          i += 2;
        } else if (mode === 2) {
          color = rgb(parts[i + 2], parts[i + 3], parts[i + 4]);
          i += 4;
        } else {
          break; // unknown colour form: ignore the rest, like terminals do
        }
      }
      if (color === undefined || n === 58) continue; // 58 is the underline colour: not shown
      s = n === 38 ? { ...s, fg: color } : { ...s, bg: color };
      continue;
    }
    if (n === 0) s = {};
    else if (n === 4 && sub.length > 1) s = { ...s, underline: toInt(sub[1]) !== 0 }; // 4:0 ends it, 4:3 is curly…
    else if (n >= 30 && n <= 37) s = { ...s, fg: n - 30 };
    else if (n >= 40 && n <= 47) s = { ...s, bg: n - 40 };
    else if (n >= 90 && n <= 97) s = { ...s, fg: n - 90 + 8 };
    else if (n >= 100 && n <= 107) s = { ...s, bg: n - 100 + 8 };
    else {
      const change = BASIC[n];
      if (change) s = { ...s, ...change };
    }
  }
  return compact(s);
}

function toInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (v === "") return 0;
  if (!/^\d{1,6}$/.test(v)) return undefined;
  return Number(v);
}

function paletteIndex(v: string | undefined): number | undefined {
  const n = toInt(v);
  return n !== undefined && n <= 255 ? n : undefined;
}

function rgb(...parts: (string | undefined)[]): AnsiColor | undefined {
  const [r, g, b] = parts.map(toInt);
  if (r === undefined || g === undefined || b === undefined) return undefined;
  return [Math.min(r, 255), Math.min(g, 255), Math.min(b, 255)];
}

/** Drops false and undefined keys, so equal styles compare equal. */
function compact(s: AnsiStyle): AnsiStyle {
  const out: AnsiStyle = {};
  for (const [k, v] of Object.entries(s) as [keyof AnsiStyle, AnsiStyle[keyof AnsiStyle]][]) {
    if (v !== undefined && v !== false) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function sameColor(a: AnsiColor | undefined, b: AnsiColor | undefined): boolean {
  if (typeof a === "object" && typeof b === "object") return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  return a === b;
}

export function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg) &&
    !a.bold === !b.bold &&
    !a.dim === !b.dim &&
    !a.italic === !b.italic &&
    !a.underline === !b.underline &&
    !a.inverse === !b.inverse &&
    !a.strike === !b.strike
  );
}

/** The plain text of parsed lines, as "Copy" puts it on the clipboard. */
export function plainLines(lines: AnsiLine[]): string[] {
  return lines.map((l) => l.map((s) => s.text).join(""));
}

/** Whether a screen shows anything at all (a task that never ran has blank rows only). */
export function hasText(lines: string[]): boolean {
  return lines.some((l) => l.trim() !== "");
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** The CSS colour of a palette index from 16 to 255, or of an RGB triple. */
export function cssColor(c: AnsiColor): string {
  if (typeof c === "object") return `rgb(${c[0]} ${c[1]} ${c[2]})`;
  if (c >= 232) {
    const v = 8 + (c - 232) * 10;
    return `rgb(${v} ${v} ${v})`;
  }
  const n = c - 16;
  return `rgb(${CUBE[Math.floor(n / 36)]} ${CUBE[Math.floor(n / 6) % 6]} ${CUBE[n % 6]})`;
}

/**
 * How a span looks: CSS classes for styles and the 16 themed colours
 * (OutputTab.css defines them for light and dark), and custom properties for
 * the other colours, which the CSS darkens on a light background so they stay
 * readable. Every value comes from numbers, never from the text.
 */
export function spanLook(style: AnsiStyle): { className?: string; vars?: Record<string, string> } {
  const classes: string[] = [];
  const vars: Record<string, string> = {};
  let fg = style.fg;
  let bg = style.bg;
  let swapped = false;
  if (style.inverse) {
    [fg, bg] = [bg, fg];
    swapped = true;
  }
  if (typeof fg === "number" && fg < 16) classes.push(`ansi-fg-${fg}`);
  else if (fg !== undefined) {
    classes.push("ansi-fg-x");
    vars["--ansi-fg"] = cssColor(fg);
  } else if (swapped) classes.push("ansi-fg-rev"); // the default background as a text colour
  if (typeof bg === "number" && bg < 16) classes.push(`ansi-bg-${bg}`);
  else if (bg !== undefined) {
    classes.push("ansi-bg-x");
    vars["--ansi-bg"] = cssColor(bg);
  } else if (swapped) classes.push("ansi-bg-rev"); // the default text colour as a background
  if (style.bold) classes.push("ansi-bold");
  if (style.dim) classes.push("ansi-dim");
  if (style.italic) classes.push("ansi-italic");
  if (style.underline) classes.push("ansi-underline");
  if (style.strike) classes.push("ansi-strike");
  return { className: classes.length ? classes.join(" ") : undefined, vars: Object.keys(vars).length ? vars : undefined };
}
