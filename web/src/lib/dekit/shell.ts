// Splitting a pasted command line the way dekit splits a cmd string (sh
// quoting rules), and spotting the shell syntax dekit refuses: dekit runs
// the program itself, with no shell, so `&&`, pipes and `$VAR` would reach
// it as plain words.

export interface SplitResult {
  words: string[];
  /** A quote left open, say. */
  error?: string;
}

/** Splits like sh: spaces separate words; '…' and "…" group; \ escapes. */
export function splitCommandLine(line: string): SplitResult {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      inWord = true;
    } else if (c === " " || c === "\t" || c === "\n") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) return { words: [], error: `A ${quote === "'" ? "single" : "double"} quote isn't closed.` };
  if (inWord) words.push(cur);
  return { words };
}

/** The first piece of shell syntax in a command line, outside quotes, or "". Mirrors dekit.ShellMetachar. */
export function shellMetachar(line: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && !single) {
      i++;
    } else if (c === "'" && !double) {
      single = !single;
    } else if (c === '"' && !single) {
      double = !double;
    } else if (single) {
      continue;
    } else if (c === "$" || c === "`") {
      return c;
    } else if (double) {
      continue;
    } else if ("|&;<>()*?[]{}~#".includes(c)) {
      if (c === "#" && i > 0 && line[i - 1] !== " ") continue;
      return c;
    }
  }
  return "";
}

/** How a word shows in a command line: quoted when it has spaces or shell syntax. */
export function quoteWord(word: string): string {
  if (word !== "" && !/[\s'"$`\\*?[\]{}()<>|&;#~]/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function joinCommand(words: string[]): string {
  return words.map(quoteWord).join(" ");
}
