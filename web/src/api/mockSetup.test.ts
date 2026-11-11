import { describe, expect, it } from "vitest";
import { lineDiff } from "../lib/diff";
import { createMockSetup } from "./mockSetup";
import type { Tools } from "./types";

const ROOT = "/home/dev/code";
const TOOLS: Tools = { dekit: "0.10.3", portless: "0.16.0", proxyRunning: true, proxyHttps: true };

describe("mock setup", () => {
  it("proposes every app of a fresh folder as new, creating both files", () => {
    const p = createMockSetup("fresh", ROOT).scan(ROOT, {});
    expect(new Set(p.apps.map((a) => a.status))).toEqual(new Set(["new"]));
    expect(p.files.map((f) => [f.path.replace(ROOT, ""), f.created, f.changed])).toEqual([
      ["/.portplane/tasks.yaml", true, true],
      ["/dekit.yaml", true, true],
    ]);
    expect(p.apps.some((a) => a.worktree === "checkout")).toBe(true);
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  it("shows what changed in a folder set up before", () => {
    const p = createMockSetup("existing", ROOT).scan(ROOT, {});
    const status = Object.fromEntries(p.apps.map((a) => [a.task, a.status]));
    expect(status["my-monorepo/web"]).toBe("unchanged");
    expect(status["my-monorepo/admin"]).toBe("changed");
    expect(status["my-monorepo/docs"]).toBe("manual");
    expect(status["my-monorepo/checkout/web"]).toBe("new");
    expect(p.apps.find((a) => a.task === "blog/studio")?.name).toBe("cms.blog"); // a hand-edited name is kept
    expect(p.change.removed).toEqual(["my-monorepo/legacy"]);
    expect(p.files.every((f) => f.changed && !f.created)).toBe(true);
  });

  it("applies overrides and changes the digest", () => {
    const s = createMockSetup("existing", ROOT);
    const base = s.scan(ROOT, {});
    const p = s.scan(ROOT, { names: { "my-monorepo/api": "Backend.my-monorepo" }, skip: { "blog/web": true } });
    const api = p.apps.find((a) => a.task === "my-monorepo/api")!;
    expect(api).toMatchObject({ name: "backend.my-monorepo", hostname: "backend.my-monorepo.localhost", status: "changed" });
    expect(api.command.slice(0, 2)).toEqual(["portless", "backend.my-monorepo"]);
    expect(p.apps.find((a) => a.task === "blog/web")).toMatchObject({ status: "skipped", skipped: true });
    expect(p.change.removed).toContain("blog/web");
    expect(p.digest).not.toBe(base.digest);
    expect(p.files[0].after).not.toContain("  blog/web:");
  });

  it("writes only the reviewed digest, then has nothing left to change", () => {
    const s = createMockSetup("fresh", ROOT);
    const p = s.scan(ROOT, {});
    expect(() => s.apply(ROOT, "nope", {})).toThrow(/scan again/);
    const res = s.apply(ROOT, p.digest, {});
    expect(res.written).toHaveLength(2);
    expect(res.tasks.find((t) => t.task === "my-monorepo/web")?.hostname).toBe("my-monorepo.localhost");
    const again = s.scan(ROOT, {});
    expect(again.files.some((f) => f.changed)).toBe(false);
    expect(new Set(again.apps.filter((a) => a.status !== "manual").map((a) => a.status))).toEqual(new Set(["unchanged"]));
  });

  it("refuses a write after the folder changed behind the review", () => {
    const s = createMockSetup("existing", ROOT);
    const p = s.scan(ROOT, {});
    s.touch();
    let status = 0;
    try {
      s.apply(ROOT, p.digest, {});
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(409);
    const fresh = s.scan(ROOT, {});
    expect(fresh.digest).not.toBe(p.digest);
    expect(s.apply(ROOT, fresh.digest, {}).written.length).toBeGreaterThan(0);
  });

  it("renders a diff that only adds the load entry to an existing dekit.yaml", () => {
    const p = createMockSetup("existing", ROOT).scan(ROOT, {});
    const dekit = p.files.find((f) => f.path.endsWith("dekit.yaml"))!;
    const changes = lineDiff(dekit.before, dekit.after).filter((l) => l.kind !== "same");
    expect(changes).toEqual([{ kind: "add", text: "  - .portplane/tasks.yaml", newNo: 11 }]);
  });

  it("rejects folders it doesn't watch", () => {
    expect(() => createMockSetup("fresh", ROOT).scan("/elsewhere", {})).toThrow(/Settings/);
  });

  it("checks tools from the machine; a missing portplane doesn't block", () => {
    const s = createMockSetup("fresh", ROOT);
    const first = s.check({ proxyRunning: false, proxyHttps: false, dekit: "0.10.3" });
    expect(first.ready).toBe(false);
    expect(first.requirements.find((r) => r.id === "portless")?.commands).toEqual(["npm install -g portless"]);
    expect(first.requirements.find((r) => r.id === "proxy")).toMatchObject({ ok: false, privilege: true });
    const second = s.check(TOOLS);
    expect(second.ready).toBe(true);
    expect(second.requirements.filter((r) => !r.ok).map((r) => r.id)).toEqual(["portplane"]);
  });
});
