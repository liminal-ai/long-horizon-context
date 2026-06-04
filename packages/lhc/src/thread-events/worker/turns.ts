import { applyChunkPlacement, planTurnOpenChunkPlacement } from "../persistence/chunks.js";
import { claimNextTrigger, claimTriggerById, markTriggerFailed, readTriggerById } from "../persistence/triggers.js";
import { readTurnByTriggerId, upsertTurnRecord } from "../persistence/turns.js";
import { withImmediateTransaction } from "../sqlite/transaction.js";
import type { CanonicalChunk, ProcessTurnEndTriggerResult, StoreRuntime, TurnProcessingTrigger } from "../types.js";
import { buildTurnProjectionDraft } from "./turn-projection.js";

export async function processNextTurnTrigger(runtime: StoreRuntime): Promise<ProcessTurnEndTriggerResult> {
  const trigger = claimNextTrigger(runtime);
  if (!trigger) {
    return { updatedChunkIds: [], completed: false, retryable: false, reason: "no_pending_trigger" };
  }
  return await processClaimedTrigger(runtime, trigger);
}

export async function processTurnTrigger(runtime: StoreRuntime, triggerId: string): Promise<ProcessTurnEndTriggerResult> {
  const claimed = claimTriggerById(runtime, triggerId);
  if (!claimed.trigger) {
    return { updatedChunkIds: [], completed: false, retryable: false, reason: claimed.reason ?? "no_pending_trigger" };
  }
  return await processClaimedTrigger(runtime, claimed.trigger);
}

async function processClaimedTrigger(runtime: StoreRuntime, trigger: TurnProcessingTrigger): Promise<ProcessTurnEndTriggerResult> {
  const existingTurn = readTurnByTriggerId(runtime, trigger.triggerId);
  if (existingTurn) {
    const completedTrigger = completeTriggerNoThrow(runtime, trigger.triggerId) ?? readTriggerById(runtime, trigger.triggerId) ?? trigger;
    return { trigger: completedTrigger, turn: existingTurn, updatedChunkIds: [], completed: true, retryable: false };
  }

  try {
    const draft = await buildTurnProjectionDraft(runtime, trigger);
    if (!draft) {
      const failed = markTriggerFailed(runtime, trigger.triggerId, "Turn trigger source state was not found.") ?? trigger;
      return { trigger: failed, updatedChunkIds: [], completed: false, retryable: true, reason: "turn_not_ready" };
    }

    const chunkPlan = await planTurnOpenChunkPlacement(runtime, draft.turn);
    const persisted = withImmediateTransaction(runtime.db, () => {
      const turn = upsertTurnRecord(runtime, {
        trigger,
        turn: draft.turn,
        startEventId: draft.startEvent.threadEventId,
        endEventId: draft.endEvent.threadEventId,
      });
      const chunk = applyChunkPlacement(runtime, chunkPlan);
      runtime.db.db.prepare(`
        UPDATE turn_trigger
        SET status = 'completed', completed_at = ?, last_error = NULL
        WHERE trigger_id = ?
      `).run(runtime.now().toISOString(), trigger.triggerId);
      return { turn, chunk };
    });

    const completedTrigger = readTriggerById(runtime, trigger.triggerId) ?? trigger;
    return {
      trigger: completedTrigger,
      turn: persisted.turn,
      updatedChunkIds: chunkIds(persisted.chunk),
      completed: true,
      retryable: false,
    };
  } catch (error) {
    const failed = markTriggerFailed(runtime, trigger.triggerId, error instanceof Error ? error.message : String(error)) ?? trigger;
    return { trigger: failed, updatedChunkIds: [], completed: false, retryable: true };
  }
}

function completeTriggerNoThrow(runtime: StoreRuntime, triggerId: string): TurnProcessingTrigger | undefined {
  try {
    return withImmediateTransaction(runtime.db, () => {
      runtime.db.db.prepare(`
        UPDATE turn_trigger
        SET status = 'completed', completed_at = ?, last_error = NULL
        WHERE trigger_id = ?
      `).run(runtime.now().toISOString(), triggerId);
      return readTriggerById(runtime, triggerId);
    });
  } catch {
    return undefined;
  }
}

function chunkIds(chunk: CanonicalChunk | undefined): string[] {
  return chunk === undefined ? [] : [chunk.chunkId];
}
