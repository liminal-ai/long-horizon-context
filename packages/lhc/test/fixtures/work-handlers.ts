// Story 1's registered test handlers: one per work kind, each calling the
// matching inference callback operation with deterministic input derived from the
// item's source id and handing the resulting form content back through the
// HandlerOutcome contract. Real handlers (Stories 2–3) read records; these
// exist so the drain's mechanics — claim, retry, terminal paths, report —
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
  SubjectKind,
  WorkHandler,
  WorkKind,
} from "../../src/index.js";
import { applyDerivationSuccess, registerTestingWork } from "../../src/index.js";
import type { DerivationType } from "./model-call.js";

interface FormSpec {
  subjectKind: SubjectKind;
  derivationType: DerivationType;
  call: (inferenceCallbacks: InferenceCallbacks, sourceId: string) => Promise<InferenceResult>;
}

const KIND_SPECS: Record<WorkKind, FormSpec[]> = {
  prompt_smoothing: [
    {
      subjectKind: "message",
      derivationType: "smoothed_prompt",
      call: (p, id) => p.smoothPrompt({ text: `prompt:${id}` }),
    },
  ],
  tool_result_summary: [
    {
      subjectKind: "message",
      derivationType: "tool_result_summary",
      call: (p, id) => p.summarizeToolResult({ toolName: "fixture", content: `result:${id}` }),
    },
  ],
  turn_derivation: [
    {
      subjectKind: "turn",
      derivationType: "turn_rendering",
      call: (p, id) =>
        p.composeTurnRendering({
          parts: [{ messageId: id, kind: "user_prompt", text: `turn:${id}`, fallback: false }],
        }),
    },
    {
      subjectKind: "turn",
      derivationType: "smooth_turn_compression",
      call: (p, id) => p.compressSmoothTurn({ rendering: `turn:${id}` }),
    },
  ],
  chunk_summary_detailed: [
    {
      subjectKind: "chunk",
      derivationType: "chunk_summary_detailed",
      call: (p, id) => p.summarizeChunkDetailed({ memberProjections: [`chunk:${id}`] }),
    },
  ],
  chunk_summary_brief: [
    {
      subjectKind: "chunk",
      derivationType: "chunk_summary_brief",
      call: (p, id) => p.summarizeChunkBrief({ memberProjections: [`chunk:${id}`] }),
    },
  ],
};

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
  for (const [kind, specs] of Object.entries(KIND_SPECS) as Array<[WorkKind, FormSpec[]]>) {
    map[kind] = async (_run, item) => {
      await hooks.onHandlerStart?.(item);
      const sourceId = item.sourceRef["messageId"] ?? item.sourceRef["turnId"] ?? item.sourceRef["chunkId"];
      if (sourceId === undefined) {
        return { ok: false, retryable: false, reason: "test handler: unrecognized sourceRef" };
      }
      const derivations: HandlerDerivationWrite[] = [];
      for (const spec of specs) {
        const result = await spec.call(inferenceCallbacks, sourceId);
        if (!result.ok) {
          return { ok: false, retryable: result.retryable, reason: result.reason };
        }
        derivations.push({
          subjectKind: spec.subjectKind,
          subjectId: sourceId,
          derivationType: spec.derivationType,
          content: result.text,
        });
      }
      return { ok: true, derivations };
    };
  }
  return map;
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
      if (handler === undefined) return { disposition: "failed", retryable: false, reason: "missing_test_handler" };
      const outcome = await handler(run, {
        workItemId: item.workItemId,
        kind,
        sourceRef: item.sourceRef as unknown as Record<string, string>,
      });
      if (outcome.ok) {
        const disposition = applyDerivationSuccess(
          run.openDb(),
          { sourceVersion: item.sourceVersion, derivations: item.derivations, workItemId: item.workItemId },
          outcome.derivations ?? [],
          run.clock().toISOString(),
          outcome.onApplied,
        );
        return { disposition };
      }
      if ("blocked" in outcome) return { disposition: "blocked", reason: outcome.reason };
      return { disposition: "failed", retryable: outcome.retryable, reason: outcome.reason };
    };
  const wrapFromItem: DurableWorkDispatcher = async (run, item) => {
    if (!(item.kind in handlers)) return { disposition: "failed", retryable: false, reason: "missing_test_handler" };
    return wrap(item.kind as WorkKind)(run, item);
  };
  return {
    "messages.derive": wrapFromItem,
    "turns.deriveTurn": wrap("turn_derivation"),
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
