import { describe, expect, it } from "vitest";
import { visibleRange } from "./windowing";

describe("visibleRange", () => {
  it("covers the screen plus the overscan", () => {
    // the table starts 100px below the top of an 800px window, rows are 40px
    expect(visibleRange(1000, 40, 100, 800, 10)).toEqual({ start: 0, end: 28 });
    // scrolled: the table's top is 4000px above the window
    expect(visibleRange(1000, 40, -4000, 800, 10)).toEqual({ start: 90, end: 130 });
    // near the end
    expect(visibleRange(1000, 40, -39_500, 800, 10)).toEqual({ start: 977, end: 1000 });
  });

  it("handles empty lists and tables below the screen", () => {
    expect(visibleRange(0, 40, 0, 800)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(500, 40, 5000, 800, 10)).toEqual({ start: 0, end: 0 });
  });
});
