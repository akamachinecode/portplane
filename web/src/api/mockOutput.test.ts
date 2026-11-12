import { describe, expect, it } from "vitest";
import { parseAnsi, plainLines } from "../lib/ansi";
import { createHttpApi } from "./client";
import { mockSnapshot } from "./mock";
import type { MockContext } from "./mockContext";
import { createMockOutput, MOCK_COLS, MOCK_ROWS, wrapRows } from "./mockOutput";
import type { Snapshot } from "./types";

const ROOT = "/home/dev/code";

function setup(snapshot: Snapshot = mockSnapshot("default")) {
  let now = Date.parse("2026-11-12T10:00:00Z");
  let snap = snapshot;
  const ctx = {
    scenario: "default",
    snapshot: () => snap,
    update: () => {},
    delay: <T,>(v: T) => Promise.resolve(v),
    later: () => {},
    jobs: undefined as never,
  } satisfies MockContext;
  const mock = createMockOutput(ctx, () => now);
  return {
    output: (machine: string, runner: string, task: string) => mock.output(machine, runner, task),
    tick: (ms: number) => (now += ms),
    edit: (fn: (s: Snapshot) => void) => {
      snap = structuredClone(snap);
      fn(snap);
    },
  };
}

const text = (screen: string) => plainLines(parseAnsi(screen));

describe("createMockOutput", () => {
  it("shows a running dev server with colours, growing over time", async () => {
    const m = setup();
    const first = await m.output("local", ROOT, "my-monorepo/web");
    expect(first.command).toBe(`dekit -C ${ROOT} attach my-monorepo/web`);
    expect(first.screen).toContain("\x1b[");
    expect(text(first.screen).join("\n")).toContain("[vite] hmr update");
    m.tick(12_000);
    const later = await m.output("local", ROOT, "my-monorepo/web");
    expect(later.screen).not.toBe(first.screen);
    const rows = text(later.screen);
    expect(rows.length).toBeLessThanOrEqual(MOCK_ROWS);
    expect(rows.every((r) => [...r].length <= MOCK_COLS)).toBe(true);
  });

  it("starts over when the app restarts and keeps the last screen when it stops", async () => {
    const m = setup();
    const web = (s: Snapshot) => s.machines[0].apps.find((a) => a.task === "my-monorepo/web")!;
    await m.output("local", ROOT, "my-monorepo/web");
    m.edit((s) => Object.assign(web(s), { pid: 99999 }));
    const restarted = text((await m.output("local", ROOT, "my-monorepo/web")).screen).join("\n");
    expect(restarted).toContain("VITE");
    expect(restarted).not.toContain("[vite]");
    m.tick(9000);
    m.edit((s) => Object.assign(web(s), { state: "off", rawState: "stopped", pid: undefined }));
    const stopped = await m.output("local", ROOT, "my-monorepo/web");
    m.tick(60_000);
    expect((await m.output("local", ROOT, "my-monorepo/web")).screen).toBe(stopped.screen);
    expect(text(stopped.screen).join("\n")).toMatch(/\[vite\][\s\S]*Stopped/);
  });

  it("shows the failure of a failed app, the log of a finished job and nothing for an app that never ran", async () => {
    const m = setup();
    expect(text((await m.output("local", ROOT, "my-monorepo/admin")).screen).join("\n")).toContain("Cannot find module '@my-monorepo/ui/vite'");
    expect(text((await m.output("local", ROOT, "my-monorepo/install")).screen).join("\n")).toContain("Done in 4.2s");
    expect((await m.output("local", ROOT, "blog/site")).screen).toBe("");
    expect((await m.output("local", ROOT, "my-monorepo-checkout/web")).screen).toBe(""); // waiting for its dependency
  });

  it("works for a remote machine and refuses an offline one or an unknown app", async () => {
    const m = setup();
    const api = text((await m.output("box", "/home/dev/src", "shop/api")).screen).join("\n");
    expect(api).toMatch(/INFO  (GET|POST|PATCH) \/api\//);
    await expect(m.output("mini", "/Users/dev/code", "x")).rejects.toThrow("machine is offline");
    await expect(m.output("local", ROOT, "nope")).rejects.toThrow("unknown app nope");
    await expect(m.output("gone", ROOT, "nope")).rejects.toThrow("unknown machine");
  });

  it("says when the project's runner is down", async () => {
    const m = setup();
    m.edit((s) => (s.machines[0].runners[0].up = false));
    expect(await m.output("local", ROOT, "my-monorepo/web")).toEqual({ screen: "", runnerDown: true, command: `dekit -C ${ROOT} attach my-monorepo/web` });
  });
});

describe("wrapRows", () => {
  it("cuts at the width, not counting colour codes", () => {
    expect(wrapRows(["\x1b[31mabcdef\x1b[0m"], 4)).toEqual(["\x1b[31mabcd", "ef\x1b[0m"]);
    expect(wrapRows(["", "→→→"], 2)).toEqual(["", "→→", "→"]);
  });
});

describe("api.output over HTTP", () => {
  it("asks /api/output with the app and passes the abort signal", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = createHttpApi("t", async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ screen: "\x1b[32mok\x1b[0m", command: "dekit attach web" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const ctl = new AbortController();
    const out = await api.output("box", "/home/dev/src", "shop/web", ctl.signal);
    expect(out.screen).toBe("\x1b[32mok\x1b[0m");
    expect(calls[0].url).toBe("/api/output?machine=box&runner=%2Fhome%2Fdev%2Fsrc&task=shop%2Fweb");
    expect(calls[0].init?.signal).toBe(ctl.signal);
    expect(calls[0].init?.method).toBe("GET");
  });
});
