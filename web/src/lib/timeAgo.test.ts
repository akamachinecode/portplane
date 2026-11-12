import { describe, expect, it } from "vitest";
import { timeAgo } from "./timeAgo";

describe("timeAgo", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  it("says how long ago, roughly", () => {
    expect(timeAgo("2026-11-12T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-11-12T11:59:00Z", now)).toBe("a minute ago");
    expect(timeAgo("2026-11-12T11:35:00Z", now)).toBe("25 minutes ago");
    expect(timeAgo("2026-11-12T09:00:00Z", now)).toBe("3 hours ago");
    expect(timeAgo("2026-11-11T10:00:00Z", now)).toBe("yesterday");
    expect(timeAgo("2026-11-08T12:00:00Z", now)).toBe("4 days ago");
    expect(timeAgo("not a date", now)).toBe("");
  });
});
