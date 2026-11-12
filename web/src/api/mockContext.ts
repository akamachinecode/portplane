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
  /**
   * Set when the context acts on a machine reached over SSH (ADR-0026):
   * snapshot() shows that machine as the local one, update() changes it,
   * and jobs carry its id. Nobody there can answer a password dialog.
   */
  remote?: { id: string; name: string };
}

/** The remote machine's project folder in the mock (mockRemote in mock.ts). */
export const MOCK_REMOTE_ROOT = "/home/dev/src";

/** The context for one machine reached over SSH. */
export function scopeMockContext(ctx: MockContext, id: string, name: string): MockContext {
  return {
    ...ctx,
    remote: { id, name },
    snapshot() {
      const s = ctx.snapshot();
      return { ...s, machines: s.machines.map((m) => ({ ...m, machine: { ...m.machine, local: m.machine.id === id } })) };
    },
    update: (fn, machine = id) => ctx.update(fn, machine),
    jobs: { ...ctx.jobs, start: (spec) => ctx.jobs.start({ ...spec, machine: id }) },
  };
}
