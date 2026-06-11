// `lhc turns delete` (Story 6) per tech design §Placement: the turn mutation
// command surface, mirroring turns.deleteTurn one-for-one (AC-6.8) — the
// operation the prompt-protection refusal points whole-exchange intent at.
// Mutations need no provider (DD-11): the cascade queues replacement work;
// only a drain dispatches handlers.
import type { ThreadRef } from "../domains/threads/index.js";
import * as turns from "../domains/turns/index.js";
import { renderResult, type CliResult } from "./render.js";

export async function runTurnsDelete(
  threadRef: ThreadRef,
  flags: { turnId: string },
): Promise<CliResult> {
  return renderResult(await turns.deleteTurn(threadRef, { turnId: flags.turnId }));
}
