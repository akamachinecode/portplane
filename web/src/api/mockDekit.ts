import type { DekitApi } from "./dekit";
import type { MockContext } from "./mockContext";

// The in-memory side of dekit.ts for `?mock` and tests. ctx reads and
// changes the mock snapshot, runs fake jobs and fakes latency.
export function createMockDekit(_ctx: MockContext): DekitApi {
  return {};
}
