import type { ToolsApi } from "./tools";
import type { MockContext } from "./mockContext";

// The in-memory side of tools.ts for `?mock` and tests. ctx reads and
// changes the mock snapshot, runs fake jobs and fakes latency.
export function createMockTools(_ctx: MockContext): ToolsApi {
  return {};
}
