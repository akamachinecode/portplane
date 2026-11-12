import type { Scenario } from "./mock";
import type { MockJobs } from "./mockJobs";
import type { MachineSnapshot, Snapshot } from "./types";

/**
 * What createMockApi hands each module's mock factory (mockPortless.ts,
 * mockDekit.ts, mockTools.ts), so a module can fake its endpoints on the same
 * in-memory state as the rest of the mock.
 */
export interface MockContext {
  scenario: Scenario;
  /** The current mock snapshot; treat it as read-only and change it with update. */
  snapshot(): Snapshot;
  /** Changes one machine (a copy) and pushes the new snapshot to subscribers. */
  update(fn: (ms: MachineSnapshot) => void, machine?: string): void;
  /** Resolves with value after a realistic delay. */
  delay<T>(value: T, ms?: number): Promise<T>;
  later(ms: number, fn: () => void): void;
  /** Fake jobs: their events reach subscribers like the server's. */
  jobs: MockJobs;
}
