import { describe, expect, it } from "vitest";
import type { DekitHelp } from "../../api/dekit";
import helpRaw from "../../api/mockDekitHelp.json?raw";
import { descParts, fieldHelp, resolveTag, searchTopics, taskKey, topicTitle } from "./help";

// A trimmed copy of dekit 0.10.3's `help --json`.
const help = JSON.parse(helpRaw) as DekitHelp;

describe("dekit help", () => {
  it("finds a field's help", () => {
    const f = fieldHelp(help, taskKey("autorestart"));
    expect(f?.type).toBe("never | on-failure | always");
    expect(f?.default).toBe("never");
    expect(fieldHelp(help, "tasks.*.nope")).toBeUndefined();
  });
  it("splits descriptions into text, code and links", () => {
    expect(descParts("Start on `dekit up` (|config/tasks#restarting|).")).toEqual([
      { kind: "text", text: "Start on " },
      { kind: "code", text: "dekit up" },
      { kind: "text", text: " (" },
      { kind: "link", tag: "config/tasks#restarting" },
      { kind: "text", text: ")." },
    ]);
  });
  it("resolves tags to topics", () => {
    expect(resolveTag(help, "config/tasks#ready")).toEqual({ topic: "config/tasks", anchor: "ready" });
    expect(topicTitle(help, "cli/reload")).toBe("dekit reload");
    expect(topicTitle(help, "unknown/topic")).toBe("unknown/topic");
  });
  it("searches topics", () => {
    expect(searchTopics(help, "reload")[0].id).toBe("cli/reload");
    expect(searchTopics(help, "zzzz-no-match")).toEqual([]);
  });
});
