import { describe, expect, it, vi } from "vitest";
import { mockSnapshot } from "../../api/mock";
import type { Target, Verb } from "../../api/types";
import type { Pending } from "../../hooks/usePending";
import { actOnEntries, BULK_ACTIONS, bulkRequests } from "./bulk";
import { layoutApps, NO_FILTERS } from "./model";

const all = layoutApps(mockSnapshot("default"), new Set(), NO_FILTERS, "activity").order;

function fakeCtx() {
  const calls: Array<{ target: Target; verb: Verb }> = [];
  const keys: string[] = [];
  const pending: Pending = {
    has: () => false,
    hasPrefix: () => false,
    run: async (key, _fp, action) => {
      keys.push(key);
      await action();
    },
  };
  const api = { act: vi.fn(async (target: Target, verb: Verb) => void calls.push({ target, verb })) };
  const toast = { info: vi.fn(), error: vi.fn() };
  return { ctx: { api: api as never, pending, toast }, calls, keys, toast };
}

describe("bulkRequests", () => {
  it("makes one request per machine and runner, with exact tasks", () => {
    const reqs = bulkRequests(all);
    expect(reqs.map((r) => r.target)).toEqual([
      {
        machine: "local",
        runner: "/home/dev/code",
        tasks: ["my-monorepo/web", "my-monorepo/api", "my-monorepo/docs", "my-monorepo/admin", "my-monorepo-checkout/install", "my-monorepo-checkout/web", "my-monorepo-checkout/api", "blog/site", "blog/studio"],
      },
      { machine: "box", runner: "/home/dev/src", tasks: ["shop/web", "shop/api", "shop/worker"] },
    ]);
  });
});

describe("actOnEntries", () => {
  it("sends each group once and marks every row pending", async () => {
    const { ctx, calls, keys } = fakeCtx();
    const stopped = BULK_ACTIONS.find((a) => a.id === "start")!.applies(all);
    await actOnEntries(ctx, stopped, "start");
    expect(calls.map((c) => `${c.target.machine}:${c.target.tasks?.join(",")}:${c.verb}`)).toEqual([
      "local:my-monorepo/admin,my-monorepo-checkout/api,blog/site,blog/studio:start",
      "box:shop/worker:start",
    ]);
    expect(keys).toHaveLength(5);
    expect(keys[0]).toBe("app|local|/home/dev/code#my-monorepo/admin|start");
  });

  it("offers Undo after a stop", async () => {
    const { ctx, calls, toast } = fakeCtx();
    const stop = BULK_ACTIONS.find((a) => a.id === "stop")!;
    const running = stop.applies(all).slice(0, 2);
    await stop.run(ctx, running);
    expect(toast.info).toHaveBeenCalledOnce();
    const [text, opts] = toast.info.mock.calls[0] as [string, { action: { label: string; run(): void } }];
    expect(text).toBe("Stopping 2 apps");
    expect(opts.action.label).toBe("Undo");
    opts.action.run();
    await Promise.resolve();
    expect(calls.map((c) => c.verb)).toEqual(["stop", "start"]);
  });
});
