import type { BatchResult, MessageEventInput, OpResult } from "lhc";
import type { LhcInstance } from "../shared/instance.js";
import { notImplemented } from "../shared/not-implemented.js";

// AC-2.1, AC-2.7: orchestrate map → accumulate → batch flush through
// `intakeStream.messageEvents`, isolating capture failure so a writable-thread
// failure becomes a recorded gap and a store-unavailable failure becomes an
// extension health signal — never a thrown exception into a PI hook. Story 2.

/** Fail-closed until Story 2. */
export function capture(
  events: MessageEventInput[],
  instance: LhcInstance,
): Promise<OpResult<BatchResult>> {
  return Promise.resolve(notImplemented<BatchResult>("capture.capture"));
}
