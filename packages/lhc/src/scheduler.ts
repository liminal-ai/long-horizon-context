// SDK-internal scheduler (DD-4) — Story 0 skeleton. Manual mode is complete
// in this story: enqueue's onCommit poke fires (shared/context.ts owns the
// poke seam), and the scheduler does nothing with it — draining is an
// explicit caller operation. Background mode's single-flight / coalesce /
// catch-up machinery is Story 1's; the mode flag exists now so createSdk
// validates its config shape from day one. This module must import domain
// surfaces only through domains/*/index.ts when Story 1 wires the drain.
export type SchedulerMode = "background" | "manual";

export interface Scheduler {
  readonly mode: SchedulerMode;
  // Post-commit nudge that work was queued for a thread. Manual mode: no-op
  // by contract (DD-5). Background mode: drain scheduling lands in Story 1;
  // until then the poke is received and deliberately not acted on — there is
  // no drain to fake (fail-closed: no pretend scheduling).
  poke(threadId: string): void;
}

export function createScheduler(mode: SchedulerMode): Scheduler {
  return {
    mode,
    poke(_threadId: string): void {
      // Story 1 fills this in for background mode.
    },
  };
}
