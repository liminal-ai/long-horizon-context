// Story 1's registered test handlers: one per work kind, each calling the
// matching inference callback operation with deterministic input derived from the
// item's source id and handing the resulting form content back through the
// HandlerOutcome contract. Real handlers (Stories 2–3) read records; these
// exist so the drain's mechanics — claim, terminal paths, report —
// are exercised against the real handler seam with the double scripted per
// test. Registered by assigning into the SDK's assembled map, the same map
// production domain tables merge into (DD-6).

import type {
  DurableWorkDispatcher,
  DurableWorkDispatcherMap,
  HandlerDerivationWrite,
  InferenceCallbacks,
  InferenceResult,
  Lhc,
  WorkHandler,
  WorkKind,
} from "../../src/index.js";
import { applyDerivationSuccess, deterministicText, registerTestingWork } from "../../src/index.js";
import type { HandlerRunContext } from "../../src/shared-tech/derivation.js";
import { enqueue } from "../../src/shared-tech/work-queue/index.js";
import type { DerivationType } from "./model-call.js";

const WORK_KINDS: readonly WorkKind[] = [
  "prompt_smoothing",
  "tool_result_summary",
  "turn_derivation",
  "detailed_turn_compression",
  "chunk_summary_detailed",
  "chunk_summary_brief",
];

export interface TestHandlerHooks {
  // Fires when a handler begins running an item — i.e. after the item's
  // claim committed and any earlier item's completion landed. The kill and
  // hold runners hang their marker/sleep protocol here.
  onHandlerStart?: (item: { workItemId: string; kind: string }) => void | Promise<void>;
}

export function testWorkHandlers(
  inferenceCallbacks: InferenceCallbacks,
  hooks: TestHandlerHooks = {},
): Partial<Record<WorkKind, WorkHandler>> {
  const map: Partial<Record<WorkKind, WorkHandler>> = {};
  for (const kind of WORK_KINDS) {
    map[kind] = async (run, item) => {
      await hooks.onHandlerStart?.(item);
      const sourceId = item.sourceRef["messageId"] ?? item.sourceRef["turnId"] ?? item.sourceRef["chunkId"];
      if (sourceId === undefined) {
        return { ok: false, reason: "test handler: unrecognized sourceRef" };
      }
      const derived = await deriveForTestWork(run, kind, inferenceCallbacks, sourceId);
      if (!derived.ok) {
        return { ok: false, reason: derived.reason };
      }
      return {
        ok: true,
        derivations: derived.derivations,
        ...(derived.onApplied === undefined ? {} : { onApplied: derived.onApplied }),
      };
    };
  }
  return map;
}

async function deriveForTestWork(
  run: HandlerRunContext,
  kind: WorkKind,
  inferenceCallbacks: InferenceCallbacks,
  sourceId: string,
): Promise<
  | {
      ok: true;
      derivations: HandlerDerivationWrite[];
      onApplied?: (transaction: { db: import("node:sqlite").DatabaseSync; onCommit: (fn: () => void) => void }) => void;
    }
  | { ok: false; reason: string }
> {
  if (kind === "prompt_smoothing") {
    return inferenceWrite(
      "message",
      sourceId,
      "smoothed_prompt",
      await inferenceCallbacks.smoothPrompt({ text: `prompt:${sourceId}` }),
    );
  }
  if (kind === "tool_result_summary") {
    return inferenceWrite(
      "message",
      sourceId,
      "tool_result_summary",
      await inferenceCallbacks.summarizeToolResult({ toolName: "fixture", content: `result:${sourceId}` }),
    );
  }
  if (kind === "turn_derivation") {
    const renderingInput = {
      parts: [{ messageId: sourceId, kind: "user_prompt", text: `turn:${sourceId}`, fallback: false }],
    };
    const renderingText = deterministicText("compressDetailedTurn", renderingInput, `turn:${sourceId}`);
    const assemblyText = `User:\nturn:${sourceId}\n\n⏺ findings for ${sourceId}`;
    return {
      ok: true,
      derivations: [
        {
          subjectKind: "turn",
          subjectId: sourceId,
          derivationType: "turn_rendering",
          content: renderingText,
        },
        {
          subjectKind: "turn",
          subjectId: sourceId,
          derivationType: "pre_detailed_assembly",
          content: assemblyText,
        },
      ],
      onApplied: (transaction) => {
        enqueue(
          {
            db: transaction.db,
            clock: run.clock,
            threadId: run.threadId,
            filePath: run.filePath,
            postCommitHook: { add: transaction.onCommit },
            poke: () => {},
          },
          {
            owner: "turns",
            kind: "detailed_turn_compression",
            sourceRef: { turnId: sourceId },
            sourceVersion: 1,
            derivations: [{ subjectKind: "turn", subjectId: sourceId, derivationType: "detailed_turn_compression" }],
          },
        );
      },
    };
  }
  if (kind === "detailed_turn_compression") {
    const assemblyText = `User:\nturn:${sourceId}\n\n⏺ findings for ${sourceId}`;
    const compression = await inferenceCallbacks.compressDetailedTurn({
      dialogueText: assemblyText,
      inputTokens: 10,
      targetMinTokens: 4,
      targetAimTokens: 5,
      targetMaxTokens: 7,
    });
    if (!compression.ok) return compression;
    return {
      ok: true,
      derivations: [
        {
          subjectKind: "turn",
          subjectId: sourceId,
          derivationType: "detailed_turn_compression",
          content: compression.text,
        },
      ],
    };
  }
  if (kind === "chunk_summary_detailed") {
    const input = { memberProjections: [`chunk:${sourceId}`] };
    return {
      ok: true,
      derivations: [
        {
          subjectKind: "chunk",
          subjectId: sourceId,
          derivationType: "chunk_summary_detailed",
          content: deterministicText("summarizeChunkBrief", input, input.memberProjections.join(" | ")),
        },
      ],
    };
  }
  if (kind === "chunk_summary_brief") {
    return inferenceWrite(
      "chunk",
      sourceId,
      "chunk_summary_brief",
      await inferenceCallbacks.summarizeChunkBrief({
        text: `chunk:${sourceId}`,
        inputTokens: 10,
        targetMinTokens: 1,
        targetAimTokens: 2,
        targetMaxTokens: 3,
      }),
    );
  }
  return { ok: false, reason: `test handler: unsupported work kind ${kind}` };
}

function inferenceWrite(
  subjectKind: "message" | "chunk",
  subjectId: string,
  derivationType: DerivationType,
  result: InferenceResult,
): { ok: true; derivations: HandlerDerivationWrite[] } | { ok: false; reason: string } {
  if (!result.ok) return result;
  return {
    ok: true,
    derivations: [{ subjectKind, subjectId, derivationType, content: result.text }],
  };
}

export function testWorkDispatchers(
  inferenceCallbacks: InferenceCallbacks,
  hooks: TestHandlerHooks = {},
): DurableWorkDispatcherMap {
  const handlers = testWorkHandlers(inferenceCallbacks, hooks);
  const wrap =
    (kind: WorkKind): DurableWorkDispatcher =>
    async (run, item) => {
      const handler = handlers[kind];
      if (handler === undefined) return { disposition: "failed", reason: "missing_test_handler" };
      const outcome = await handler(run, {
        workItemId: item.workItemId,
        kind,
        sourceRef: item.sourceRef as unknown as Record<string, string>,
      });
      if (outcome.ok) {
        const disposition = applyDerivationSuccess(
          run.openDb(),
          {
            sourceVersion: item.sourceVersion,
            derivations: item.derivations,
            workItemId: item.workItemId,
          },
          outcome.derivations ?? [],
          run.clock().toISOString(),
          outcome.onApplied,
        );
        return { disposition };
      }
      if ("deferred" in outcome) {
        return { disposition: "failed", reason: "unsupported_deferred_test_handler" };
      }
      if ("blocked" in outcome) return { disposition: "blocked", reason: outcome.reason };
      return { disposition: "failed", reason: outcome.reason };
    };
  const wrapFromItem: DurableWorkDispatcher = async (run, item) => {
    if (!(item.kind in handlers)) return { disposition: "failed", reason: "missing_test_handler" };
    return wrap(item.kind as WorkKind)(run, item);
  };
  return {
    "messages.derive": wrapFromItem,
    "turns.deriveTurn": wrap("turn_derivation"),
    "turns.deriveDetailedTurnCompression": wrap("detailed_turn_compression"),
    "turns.deriveDetailedChunk": wrap("chunk_summary_detailed"),
    "turns.deriveBriefChunk": wrap("chunk_summary_brief"),
  };
}

export function registerTestWorkHandlers(
  sdk: Lhc,
  inferenceCallbacks: InferenceCallbacks,
  hooks?: TestHandlerHooks,
): void {
  registerTestingWork(sdk, {
    handlers: testWorkHandlers(inferenceCallbacks, hooks),
    dispatchers: testWorkDispatchers(inferenceCallbacks, hooks),
  });
}
