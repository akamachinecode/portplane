import type { PortlessApi } from "./portless";
import type { MockContext } from "./mockContext";

// The in-memory side of portless.ts for `?mock` and tests. ctx reads and
// changes the mock snapshot, runs fake jobs and fakes latency.
export function createMockPortless(_ctx: MockContext): PortlessApi {
  return {};
}
