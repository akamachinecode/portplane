import { describe, expect, it } from "vitest";
import { readToken } from "./token";

function docWith(content: string | null) {
  return {
    querySelector: () => (content === null ? null : ({ getAttribute: () => content } as unknown as Element)),
  };
}

describe("readToken", () => {
  it("returns the injected token", () => {
    expect(readToken(docWith("abc123"))).toBe("abc123");
  });
  it("ignores the unreplaced placeholder", () => {
    expect(readToken(docWith("__PORTPLANE_TOKEN__"))).toBeNull();
  });
  it("handles a missing meta tag", () => {
    expect(readToken(docWith(null))).toBeNull();
  });
});
