import type { ProcessTurnEndTriggerResult, StoreRuntime } from "../types.js";

export async function processNextTurnTrigger(_runtime: StoreRuntime): Promise<ProcessTurnEndTriggerResult> {
  return { updatedChunkIds: [], completed: false, retryable: false, reason: "no_pending_trigger" };
}

export async function processTurnTrigger(_runtime: StoreRuntime, _triggerId: string): Promise<ProcessTurnEndTriggerResult> {
  return { updatedChunkIds: [], completed: false, retryable: false, reason: "no_pending_trigger" };
}
