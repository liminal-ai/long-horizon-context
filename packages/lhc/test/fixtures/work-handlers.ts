// Story 1's registered test handlers: one per work kind, each calling the
// matching inference callback operation with deterministic input derived from the
// item's source id and handing the resulting form content back through the
// HandlerOutcome contract. Real handlers (Stories 2–3) read records; these
// exist so the drain's mechanics — claim, retry, terminal paths, report —
// are exercised against the real handler seam with the double scripted per
// test. Registered by assigning into the SDK's assembled map, the same map
// production domain tables merge into (DD-6).
import type {
  InferenceCallbacks,
  InferenceResult,
  HandlerDerivationWrite,
  Lhc,
  SubjectKind,
  WorkHandler,
  WorkKind,
} from "../../src/index.js";
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
      const sourceId =
        item.sourceRef["messageId"] ?? item.sourceRef["turnId"] ?? item.sourceRef["chunkId"];
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

// Registration is plain assignment into the assembled per-SDK map — the same
// map initLhc merged the (empty until Stories 2–3) domain tables into.
export function registerTestWorkHandlers(
  sdk: Lhc,
  inferenceCallbacks: InferenceCallbacks,
  hooks?: TestHandlerHooks,
): void {
  Object.assign(sdk.workHandlers, testWorkHandlers(inferenceCallbacks, hooks));
}
