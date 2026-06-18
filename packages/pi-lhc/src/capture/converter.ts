import type { BatchResult, MessageEventInput, OpResult } from "lhc";
import type { LhcInstance } from "../shared/instance.js";
import { fingerprint } from "./idempotency.js";

// AC-2.1, AC-2.7: flush a mapped batch through `intakeStream.messageEvents`,
// isolating capture failure so it never throws back into a PI hook. The two
// failure shapes the AC distinguishes key off the SDK's error code:
//   - `invalid_event` (a malformed/unmappable event on a WRITABLE thread):
//     record a durable, queryable gap (a `runtime_note`) so nothing is silently
//     dropped, then surface the original failure so the caller marks the gap.
//   - anything else (thread store unavailable): no durable gap is possible —
//     surface the failure for the caller to route to an extension health
//     signal. Either way the session continues.
//
// The map → accumulate orchestration runs in the composition root (index.ts),
// which routes this function's structured result into SessionState.health;
// capture itself stays boundary-pure (lhc + shared only).

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** messageEvents returns OpResults for operational failures, but a thread file
 *  in a genuinely broken state could still throw — contain that too, so capture
 *  is total. */
async function flushIsolated(
  instance: LhcInstance,
  events: readonly MessageEventInput[],
): Promise<OpResult<BatchResult>> {
  try {
    return await instance.sdk.intakeStream.messageEvents(instance.threadRef, events);
  } catch (cause) {
    return {
      ok: false,
      error: {
        errorClass: "system_error",
        code: "storage_failure",
        reason: `capture flush threw: ${detail(cause)}`,
      },
    };
  }
}

/** A durable, queryable gap marker for a rejected batch — a `runtime_note` so it
 *  rides an existing intake kind (no new kind) and surfaces in the event log.
 *  Its key is a fingerprint of the rejected batch, so re-delivery of the same
 *  bad batch dedups the gap rather than piling up duplicates. */
function gapNote(events: readonly MessageEventInput[], reason: string): MessageEventInput {
  const text = `capture gap: ${events.length} event(s) rejected — ${reason}`;
  return {
    eventKind: "runtime_note",
    idempotencyKey: `pi-lhc:gap:${fingerprint(JSON.stringify(events), reason)}`,
    actor: "system",
    harness: "pi",
    payload: { text },
  };
}

function syntheticGapNote(discriminator: string, reason: string): MessageEventInput {
  const text = `capture gap: unmappable PI hook input rejected — ${reason}`;
  return {
    eventKind: "runtime_note",
    idempotencyKey: `pi-lhc:gap:${fingerprint(discriminator, reason)}`,
    actor: "system",
    harness: "pi",
    payload: { text },
  };
}

export async function capture(events: MessageEventInput[], instance: LhcInstance): Promise<OpResult<BatchResult>> {
  const primary = await flushIsolated(instance, events);
  if (primary.ok) return primary;

  if (primary.error.code === "invalid_event") {
    // Writable thread, malformed event: never drop — record a durable gap.
    const gap = await flushIsolated(instance, [gapNote(events, primary.error.reason)]);
    // If the gap write itself fails, the store went unavailable: surface that
    // (no durable gap was recorded) so the caller routes it to health.
    if (!gap.ok) return gap;
    return primary;
  }

  // Store unavailable / other: no durable gap is possible.
  return primary;
}

export async function captureGap(
  discriminator: string,
  reason: string,
  instance: LhcInstance,
): Promise<OpResult<BatchResult>> {
  return flushIsolated(instance, [syntheticGapNote(discriminator, reason)]);
}
