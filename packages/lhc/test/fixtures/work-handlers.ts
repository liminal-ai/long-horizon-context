// Story 1's registered test handlers: one per work kind, each calling the
// matching provider operation with deterministic input derived from the
// item's source id and handing the resulting form content back through the
// HandlerOutcome contract. Real handlers (Stories 2–3) read records; these
// exist so the drain's mechanics — claim, retry, terminal paths, report —
// are exercised against the real handler seam with the double scripted per
// test. Registered by assigning into the SDK's assembled map, the same map
// production domain tables merge into (DD-6).
import type {
  DerivationProvider,
  HandlerFormWrite,
  Lhc,
  ProviderResult,
  SubjectKind,
  FormKind,
  WorkHandler,
  WorkKind,
} from "../../src/index.js";

interface FormSpec {
  subjectKind: SubjectKind;
  form: FormKind;
  call: (provider: DerivationProvider, sourceId: string) => Promise<ProviderResult>;
}

const KIND_SPECS: Record<WorkKind, FormSpec[]> = {
  prompt_smoothing: [
    {
      subjectKind: "message",
      form: "smoothed_prompt",
      call: (p, id) => p.smoothPrompt({ text: `prompt:${id}` }),
    },
  ],
  tool_call_summary: [
    {
      subjectKind: "message",
      form: "tool_call_summary",
      call: (p, id) => p.summarizeToolCall({ toolName: "fixture", argsJson: `{"source":"${id}"}` }),
    },
  ],
  tool_result_summary: [
    {
      subjectKind: "message",
      form: "tool_result_summary",
      call: (p, id) => p.summarizeToolResult({ toolName: "fixture", content: `result:${id}` }),
    },
  ],
  turn_derivation: [
    {
      subjectKind: "turn",
      form: "turn_rendering",
      call: (p, id) =>
        p.composeTurnRendering({
          parts: [{ messageId: id, kind: "user_prompt", text: `turn:${id}`, fallback: false }],
        }),
    },
    {
      subjectKind: "turn",
      form: "lower_band_projection",
      call: (p, id) => p.projectLowerBand({ rendering: `turn:${id}` }),
    },
  ],
  chunk_summary_detailed: [
    {
      subjectKind: "chunk",
      form: "chunk_summary_detailed",
      call: (p, id) => p.summarizeChunkDetailed({ memberProjections: [`chunk:${id}`] }),
    },
  ],
  chunk_summary_brief: [
    {
      subjectKind: "chunk",
      form: "chunk_summary_brief",
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
  provider: DerivationProvider,
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
      const forms: HandlerFormWrite[] = [];
      for (const spec of specs) {
        const result = await spec.call(provider, sourceId);
        if (!result.ok) {
          return { ok: false, retryable: result.retryable, reason: result.reason };
        }
        forms.push({
          subjectKind: spec.subjectKind,
          subjectId: sourceId,
          form: spec.form,
          content: result.text,
        });
      }
      return { ok: true, forms };
    };
  }
  return map;
}

// Registration is plain assignment into the assembled per-SDK map — the same
// map createSdk merged the (empty until Stories 2–3) domain tables into.
export function registerTestWorkHandlers(
  sdk: Lhc,
  provider: DerivationProvider,
  hooks?: TestHandlerHooks,
): void {
  Object.assign(sdk.workHandlers, testWorkHandlers(provider, hooks));
}
