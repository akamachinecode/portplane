import { describe, expect, it } from "vitest";
import { neighbourhood } from "./graph";

describe("neighbourhood", () => {
  it("puts what a task needs left and what needs it right", () => {
    const deps = new Map([
      ["install", []],
      ["db", []],
      ["api", ["install", "db"]],
      ["web", ["api"]],
      ["admin", ["api"]],
      ["e2e", ["web"]],
      ["other", []],
    ]);
    const g = neighbourhood("api", deps);
    const col = Object.fromEntries(g.nodes.map((n) => [n.id, n.col]));
    expect(col).toEqual({ api: 0, db: -1, install: -1, admin: 1, web: 1, e2e: 2 });
    expect(g.edges).toContainEqual({ from: "install", to: "api" });
    expect(g.edges).toContainEqual({ from: "web", to: "e2e" });
    expect(g.cols).toEqual([-1, 0, 1, 2]);
    expect(g.rows).toBe(2);
  });
  it("is just the task when it is alone", () => {
    expect(neighbourhood("x", new Map([["x", []]])).nodes).toEqual([{ id: "x", col: 0, row: 0 }]);
  });
});
