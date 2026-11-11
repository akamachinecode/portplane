import { describe, expect, it } from "vitest";
import { diffStats, foldContext, lineDiff, splitLines, type DiffLine } from "./diff";

/** Rebuilds both texts from a diff: the two sides must come back unchanged. */
function sides(lines: DiffLine[]): { before: string[]; after: string[] } {
  return {
    before: lines.filter((l) => l.kind !== "add").map((l) => l.text),
    after: lines.filter((l) => l.kind !== "del").map((l) => l.text),
  };
}

const kinds = (lines: DiffLine[]) => lines.map((l) => `${l.kind === "same" ? " " : l.kind === "add" ? "+" : "-"}${l.text}`);

describe("splitLines", () => {
  it("drops one trailing newline and treats CRLF as LF", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });
});

describe("lineDiff", () => {
  it("marks identical texts as unchanged", () => {
    const d = lineDiff("a\nb\n", "a\nb\n");
    expect(d.every((l) => l.kind === "same")).toBe(true);
    expect(d).toHaveLength(2);
  });

  it("shows a created file as all added, numbered from 1", () => {
    const d = lineDiff("", "load:\n  - .portplane/tasks.yaml\n");
    expect(d).toEqual([
      { kind: "add", text: "load:", newNo: 1 },
      { kind: "add", text: "  - .portplane/tasks.yaml", newNo: 2 },
    ]);
  });

  it("shows an emptied file as all removed", () => {
    expect(kinds(lineDiff("a\nb\n", ""))).toEqual(["-a", "-b"]);
  });

  it("puts removals before additions in a changed block", () => {
    expect(kinds(lineDiff("a\nb\nc\n", "a\nB\nc\n"))).toEqual([" a", "-b", "+B", " c"]);
  });

  it("numbers both sides across insertions", () => {
    const d = lineDiff("a\nb\nc\n", "a\nx\ny\nb\nc\n");
    expect(kinds(d)).toEqual([" a", "+x", "+y", " b", " c"]);
    expect(d[3]).toEqual({ kind: "same", text: "b", oldNo: 2, newNo: 4 });
    expect(d[4]).toEqual({ kind: "same", text: "c", oldNo: 3, newNo: 5 });
  });

  it("finds the longest common run inside the changed middle", () => {
    const d = lineDiff("tasks:\n  a:\n  b:\n  c:\n", "tasks:\n  b:\n  c:\n  d:\n");
    expect(kinds(d)).toEqual([" tasks:", "-  a:", "   b:", "   c:", "+  d:"]);
  });

  it("ignores a missing final newline", () => {
    expect(kinds(lineDiff("a\nb", "a\nb\n"))).toEqual([" a", " b"]);
  });

  it("always rebuilds both sides", () => {
    // a deterministic pseudo-random walk over small alphabets
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: rnd(12) }, () => "abcd"[rnd(4)]);
      const b = Array.from({ length: rnd(12) }, () => "abcd"[rnd(4)]);
      const d = lineDiff(a.join("\n"), b.join("\n"));
      expect(sides(d)).toEqual({ before: a, after: b });
      expect(d.filter((l) => l.kind === "same").length).toBeLessThanOrEqual(Math.min(a.length, b.length));
    }
  });

  it("falls back to remove-then-add for huge changes, still correctly", () => {
    const a = Array.from({ length: 2500 }, (_, i) => `old ${i}`);
    const b = Array.from({ length: 2500 }, (_, i) => `new ${i}`);
    const d = lineDiff(["head", ...a, "tail"].join("\n"), ["head", ...b, "tail"].join("\n"));
    expect(sides(d)).toEqual({ before: ["head", ...a, "tail"], after: ["head", ...b, "tail"] });
    expect(diffStats(d)).toEqual({ added: 2500, removed: 2500 });
  });
});

describe("diffStats", () => {
  it("counts added and removed lines", () => {
    expect(diffStats(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n"))).toEqual({ added: 2, removed: 1 });
  });
});

describe("foldContext", () => {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it("keeps three lines around a change and folds the rest", () => {
    const before = numbered(20);
    const after = [...before];
    after[9] = "changed";
    const chunks = foldContext(lineDiff(before.join("\n"), after.join("\n")));
    expect(chunks.map((c) => [c.kind, c.lines.length])).toEqual([
      ["fold", 6],
      ["lines", 8], // 3 + del + add + 3
      ["fold", 7],
    ]);
    expect(chunks[1].lines[0]).toMatchObject({ text: "line 7", oldNo: 7 });
  });

  it("does not fold a short gap between two changes", () => {
    const before = numbered(12);
    const after = [...before];
    after[2] = "x";
    after[9] = "y"; // 6 unchanged lines between: 3 + 3 kept, nothing worth folding
    const chunks = foldContext(lineDiff(before.join("\n"), after.join("\n")));
    expect(chunks.map((c) => c.kind)).toEqual(["lines"]);
  });

  it("folds a long gap between two changes", () => {
    const before = numbered(30);
    const after = [...before];
    after[0] = "x";
    after[29] = "y";
    const chunks = foldContext(lineDiff(before.join("\n"), after.join("\n")));
    expect(chunks.map((c) => [c.kind, c.lines.length])).toEqual([
      ["lines", 5], // -1 +x and 3 after
      ["fold", 22],
      ["lines", 5], // 3 before, -30 +y
    ]);
  });

  it("folds everything when nothing changed, and nothing when it is all new", () => {
    const same = lineDiff("a\nb\nc\nd\n", "a\nb\nc\nd\n");
    expect(foldContext(same).map((c) => c.kind)).toEqual(["fold"]);
    expect(foldContext(lineDiff("", "a\nb\n")).map((c) => c.kind)).toEqual(["lines"]);
    expect(foldContext([])).toEqual([]);
  });

  it("keeps every line in some chunk, in order", () => {
    const before = numbered(40);
    const after = before.filter((_, i) => i !== 5 && i !== 30);
    const d = lineDiff(before.join("\n"), after.join("\n"));
    expect(foldContext(d).flatMap((c) => c.lines)).toEqual(d);
  });
});
