import { describe, expect, it } from "vitest";
import { findMatches, isFindShortcut, matchLabel, segmentLine, stepMatch } from "./outputSearch";

describe("findMatches", () => {
  it("finds every match, ignoring case, without overlaps", () => {
    expect(findMatches(["Error: boom", "no", "error ERROR"], "error")).toEqual([
      { line: 0, start: 0, end: 5 },
      { line: 2, start: 0, end: 5 },
      { line: 2, start: 6, end: 11 },
    ]);
    expect(findMatches(["aaaa"], "aa")).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 2, end: 4 },
    ]);
  });

  it("finds nothing without a query, and treats the query as plain text", () => {
    expect(findMatches(["anything"], "")).toEqual([]);
    expect(findMatches(["a.b axb", "(1)"], ".")).toEqual([{ line: 0, start: 1, end: 2 }]);
    expect(findMatches(["(1)"], "(1)")).toEqual([{ line: 0, start: 0, end: 3 }]);
  });

  it("keeps offsets right when lower-casing would change a line's length", () => {
    expect(findMatches(["İstanbul error"], "error")).toEqual([{ line: 0, start: 9, end: 14 }]);
  });
});

describe("stepMatch and matchLabel", () => {
  it("wraps around both ends", () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(5, 3, 1)).toBe(0);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });

  it("says where the user is", () => {
    expect(matchLabel(0, 12, "x")).toBe("1 of 12");
    expect(matchLabel(-1, 2, "x")).toBe("0 of 2");
    expect(matchLabel(-1, 0, "x")).toBe("No matches");
    expect(matchLabel(-1, 0, "")).toBe("");
  });
});

describe("segmentLine", () => {
  const red = { fg: 1 };
  const green = { fg: 2 };

  it("cuts spans at the matches and keeps their styles", () => {
    const spans = [
      { text: "abc", style: red },
      { text: "def", style: green },
    ];
    expect(segmentLine(spans, [{ start: 2, end: 4, index: 7 }])).toEqual([
      { text: "ab", style: red },
      { text: "c", style: red, match: 7 },
      { text: "d", style: green, match: 7 },
      { text: "ef", style: green },
    ]);
  });

  it("handles several matches in one span, and none", () => {
    const spans = [{ text: "a-a-a", style: {} }];
    expect(segmentLine(spans, [])).toBe(spans);
    expect(
      segmentLine(spans, [
        { start: 0, end: 1, index: 0 },
        { start: 2, end: 3, index: 1 },
        { start: 4, end: 5, index: 2 },
      ]),
    ).toEqual([
      { text: "a", style: {}, match: 0 },
      { text: "-", style: {} },
      { text: "a", style: {}, match: 1 },
      { text: "-", style: {} },
      { text: "a", style: {}, match: 2 },
    ]);
  });
});

describe("isFindShortcut", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  it("is Ctrl+F, or ⌘F on macOS", () => {
    expect(isFindShortcut(key("f", { ctrlKey: true }), false)).toBe(true);
    expect(isFindShortcut(key("F", { ctrlKey: true }), false)).toBe(true);
    expect(isFindShortcut(key("f", { metaKey: true }), true)).toBe(true);
    expect(isFindShortcut(key("f", { metaKey: true }), false)).toBe(false);
    expect(isFindShortcut(key("f", { ctrlKey: true }), true)).toBe(false);
    expect(isFindShortcut(key("f", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isFindShortcut(key("f"), false)).toBe(false);
  });
});
