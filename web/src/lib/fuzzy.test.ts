import { describe, expect, it } from "vitest";
import { fuzzyMatch, highlightRuns } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence, ignoring case and spaces in the query", () => {
    expect(fuzzyMatch("hlth", "Health")?.indices).toEqual([0, 3, 4, 5]);
    expect(fuzzyMatch("RST API", "Restart api")).not.toBeNull();
    expect(fuzzyMatch("api", "Restart web")).toBeNull();
    expect(fuzzyMatch("toolong", "tool")).toBeNull();
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("prefers word starts and letters in a row over the first occurrence", () => {
    // greedy matching would take the "w" of "Show"
    expect(fuzzyMatch("web", "Show the web app")?.indices).toEqual([9, 10, 11]);
    expect(fuzzyMatch("gh", "Go to Health")?.indices).toEqual([0, 6]);
    expect(fuzzyMatch("sb", "Collapse the sidebar")?.indices).toEqual([13, 17]);
  });

  it("ranks closer matches higher", () => {
    const score = (q: string, t: string) => fuzzyMatch(q, t)?.score ?? -Infinity;
    expect(score("apps", "Apps")).toBeGreaterThan(score("apps", "Copy URL of api · my-monorepo · This computer"));
    expect(score("web", "web")).toBeGreaterThan(score("web", "Open web"));
    expect(score("set", "Settings")).toBeGreaterThan(score("set", "Restart docs"));
    expect(score("dom", "Domains")).toBeGreaterThan(score("dom", "Use the dark theme · mode"));
  });
});

describe("highlightRuns", () => {
  it("splits text into marked and plain runs", () => {
    expect(highlightRuns("Health", [0, 2, 3, 5])).toEqual([
      { text: "H", match: true },
      { text: "e", match: false },
      { text: "al", match: true },
      { text: "t", match: false },
      { text: "h", match: true },
    ]);
    expect(highlightRuns("plain", [])).toEqual([{ text: "plain", match: false }]);
  });
});
