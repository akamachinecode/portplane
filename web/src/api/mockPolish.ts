import type { MockContext } from "./mockContext";
import type { PolishApi, UpdateCheck } from "./polish";

// The in-memory side of polish.ts for `?mock` and tests: Portplane and
// portless have something new, dekit is current.
export function createMockPolish(ctx: MockContext): PolishApi {
  let last: UpdateCheck | null = null;
  return {
    updates: () => ctx.delay(last),
    async checkUpdates() {
      await ctx.delay(undefined, 900);
      const tools = ctx.snapshot().machines[0]?.tools;
      last = {
        checkedAt: new Date().toISOString(),
        items: [
          { id: "portplane", name: "Portplane", installed: "0.4.0", latest: "0.5.0", update: true, notes: "https://github.com/akamachinecode/portplane/releases/tag/v0.5.0" },
          tools?.dekit
            ? { id: "dekit", name: "dekit", installed: tools.dekit, latest: tools.dekit, update: false, notes: `https://github.com/pvolok/dekit/releases/tag/v${tools.dekit}` }
            : { id: "dekit", name: "dekit", latest: "0.10.3", update: false, notes: "https://github.com/pvolok/dekit/releases/tag/v0.10.3" },
          tools?.portless
            ? { id: "portless", name: "portless", installed: tools.portless, latest: "0.17.1", update: true, notes: "https://github.com/vercel-labs/portless/releases" }
            : { id: "portless", name: "portless", error: "couldn't connect: the npm registry did not answer" , update: false },
        ],
      };
      return last;
    },
    async exportDiagnostics() {
      await ctx.delay(undefined, 1200);
      return { path: "/home/dev/Downloads/portplane-diagnostics-2026-11-12-0930.zip", dialog: false, revealed: true };
    },
    testNotification: () => ctx.delay(undefined, 200),
    setWindowTheme: () => ctx.delay(undefined, 20),
  };
}
