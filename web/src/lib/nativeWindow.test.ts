import { describe, expect, it } from "vitest";
import { dragIntent } from "./nativeWindow";

// A stand-in for an element: which selectors its closest() matches.
const el = (...matches: string[]) => ({
  closest: (sel: string) => (matches.some((m) => sel.includes(m)) ? {} : null),
});

describe("dragIntent", () => {
  it("drags from a drag region, and zooms on a double-click", () => {
    expect(dragIntent(el("[data-drag-region]"), 0, 1)).toBe("drag");
    expect(dragIntent(el("[data-drag-region]"), 0, 2)).toBe("zoom");
  });
  it("leaves buttons, links and fields inside a region alone", () => {
    expect(dragIntent(el("[data-drag-region]", "button"), 0, 1)).toBeNull();
    expect(dragIntent(el("[data-drag-region]", "a[href]"), 0, 1)).toBeNull();
    expect(dragIntent(el("[data-drag-region]", "[data-no-drag]"), 0, 1)).toBeNull();
  });
  it("ignores other buttons, and clicks outside a region", () => {
    expect(dragIntent(el("[data-drag-region]"), 2, 1)).toBeNull();
    expect(dragIntent(el(), 0, 1)).toBeNull();
    expect(dragIntent(null, 0, 1)).toBeNull();
  });
});
