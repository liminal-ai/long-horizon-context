// Shared case tables for the frozen-contract differentials.
//
// These inputs are consumed twice: by the differential tests (comparing the
// port against checked-in goldens) and by the golden regeneration harness
// (regen_frozen_goldens.test.ts, env-gated), which runs them through the
// PINNED frozen TypeScript implementation and records the expected outputs.
// The pin is CONTRACT_PIN below; regeneration refuses to run unless
// packages/lhc/src is byte-identical to it.

import { EVENT_KINDS } from "./intake_validate.js";
import type { ComposeDerivationRow, ComposeMessage } from "./turn_compose.js";
import type { SelectionInputs } from "./view_select.js";

export const CONTRACT_PIN = "f6510314fe545b363e65e5059201b8d7119bac96";

// JSON.stringify(undefined) is undefined (not a string) — a validator that
// returns undefined for a valid input would silently drop its golden case.
// Encode undefined explicitly so accept-cases are first-class golden entries.
export function encodeFrozenCase(value: unknown): string {
  return JSON.stringify(value) ?? "__undefined__";
}

export function viewSelectFixture(): SelectionInputs {
  return {
    messages: [
      { messageId: "m1", order: 1, kind: "user_prompt", tokenEstimate: 100, turnId: "t1", text: "one" },
      { messageId: "m2", order: 2, kind: "assistant_text", tokenEstimate: 100, turnId: "t1", text: "one-a" },
      { messageId: "m3", order: 3, kind: "user_prompt", tokenEstimate: 100, turnId: "t2", text: "two" },
      { messageId: "m4", order: 4, kind: "assistant_text", tokenEstimate: 100, turnId: "t2", text: "two-a" },
      { messageId: "m5", order: 5, kind: "user_prompt", tokenEstimate: 1, turnId: "t3", text: "tail" },
    ],
    turns: [
      { turnId: "t1", turnOrder: 1, status: "closed", openedAt: 0, closedAt: 2 },
      { turnId: "t2", turnOrder: 2, status: "closed", openedAt: 2, closedAt: 4 },
      { turnId: "t3", turnOrder: 3, status: "open", openedAt: 4, closedAt: null },
    ],
    chunks: [],
    derivations: new Map([
      ["t1/turn_rendering", { state: "ready" as const, content: "alpha" }],
      ["t2/turn_rendering", { state: "ready" as const, content: "b" }],
    ]),
    maxEventOrder: 5,
    derivationCounts: { turn_rendering: { ready: 2 } },
  };
}

export const VIEW_SELECT_CONFIG = {
  lowerBound: 100,
  percentages: { full: 10, smooth: 2, detailed: 44, brief: 44 },
};

export function turnComposeFixture(): {
  messages: ComposeMessage[];
  derivations: Map<string, ComposeDerivationRow>;
} {
  return {
    messages: [
      {
        messageId: "m1",
        kind: "user_prompt",
        blocks: [{ blockType: "text", content: { text: "  Please inspect this.  " } }],
      },
      {
        messageId: "m2",
        kind: "tool_call",
        blocks: [
          { blockType: "tool_call", content: { toolCallId: "call-1", toolName: "read", arguments: { path: "a" } } },
        ],
      },
      {
        messageId: "m3",
        kind: "assistant_thinking",
        blocks: [{ blockType: "text", content: { text: "checking" } }],
      },
      {
        messageId: "m4",
        kind: "tool_result",
        blocks: [{ blockType: "tool_result", content: { toolCallId: "call-1", content: "file body", isError: false } }],
      },
      {
        messageId: "m5",
        kind: "runtime_note",
        blocks: [{ blockType: "text", content: { text: "after tool" } }],
      },
      {
        messageId: "m6",
        kind: "assistant_text",
        blocks: [{ blockType: "text", content: { text: "Done." } }],
      },
    ],
    derivations: new Map([
      ["m1/smoothed_prompt", { state: "failed", reason: "provider_failure", sourceVersion: 2 }],
      [
        "m4/tool_result_summary",
        { state: "ready", content: "read succeeded", metadata: { outcome: "succeeded" }, sourceVersion: 1 },
      ],
    ]),
  };
}

const payloads: Record<(typeof EVENT_KINDS)[number], Record<string, unknown>> = {
  user_prompt: { text: "prompt" },
  assistant_text: { text: "answer" },
  assistant_thinking: { text: "considering" },
  runtime_note: { text: "restarted" },
  model_change: { previousModel: "gpt-5", newModel: "gpt-5.1" },
  thinking_level_change: { previousLevel: "medium", newLevel: "high" },
  tool_call: { toolCallId: "call-1", toolName: "read", arguments: { path: "README.md" } },
  tool_result: { toolCallId: "call-1", content: "contents", isError: false },
  turn_end: {},
};

function event(kind: (typeof EVENT_KINDS)[number], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventKind: kind,
    idempotencyKey: `validation-${kind}`,
    actor: "fixture-actor",
    harness: "fixture-harness",
    payload: payloads[kind],
    ...overrides,
  };
}

export interface ValidationCase {
  name: string;
  input: unknown;
}

export function eventCases(): ValidationCase[] {
  const withoutIdempotencyKey = event("user_prompt");
  delete withoutIdempotencyKey["idempotencyKey"];
  const withoutEventKind = event("user_prompt");
  delete withoutEventKind["eventKind"];
  const cases: ValidationCase[] = EVENT_KINDS.map((kind) => ({
    name: `accepts ${kind}`,
    input: [event(kind)],
  }));

  for (const field of ["eventOrder", "recordedAt", "threadEventId", "schemaVersion"]) {
    cases.push({
      name: `rejects caller-supplied server field ${field}`,
      input: [event("user_prompt", { [field]: field === "eventOrder" ? 7 : "generated" })],
    });
  }

  cases.push(
    { name: "rejects a non-array batch", input: { event: event("user_prompt") } },
    { name: "rejects an empty batch", input: [] },
    { name: "rejects an unknown event field", input: [event("user_prompt", { surprise: true })] },
    { name: "rejects an unknown event kind", input: [event("user_prompt", { eventKind: "mystery_kind" })] },
    { name: "rejects a missing event kind", input: [withoutEventKind] },
    { name: "rejects a non-string event kind", input: [event("user_prompt", { eventKind: 7 })] },
    { name: "rejects a missing idempotency key", input: [withoutIdempotencyKey] },
    { name: "rejects an undefined idempotency key", input: [event("user_prompt", { idempotencyKey: undefined })] },
    { name: "rejects an empty idempotency key", input: [event("user_prompt", { idempotencyKey: "" })] },
    { name: "rejects a non-string actor", input: [event("user_prompt", { actor: 7 })] },
    { name: "rejects an empty actor", input: [event("user_prompt", { actor: "" })] },
    { name: "rejects a missing harness", input: [event("user_prompt", { harness: undefined })] },
    { name: "rejects an empty harness", input: [event("user_prompt", { harness: "" })] },
    { name: "rejects a missing payload", input: [event("user_prompt", { payload: undefined })] },
    { name: "rejects a non-object payload", input: [event("user_prompt", { payload: "text" })] },
    { name: "rejects an array payload", input: [event("user_prompt", { payload: [] })] },
  );

  for (const [name, value] of [
    ["null", null],
    ["array", []],
    ["string", "event"],
    ["number", 1],
    ["boolean", true],
  ] as const) {
    cases.push({ name: `rejects a non-object event (${name})`, input: [value] });
  }

  for (const kind of ["user_prompt", "assistant_text", "assistant_thinking", "runtime_note"] as const) {
    cases.push({ name: `rejects malformed ${kind} payload`, input: [event(kind, { payload: { text: 7 } })] });
    cases.push({
      name: `rejects unknown ${kind} payload field`,
      input: [event(kind, { payload: { text: "valid", surprise: true } })],
    });
  }

  cases.push(
    {
      name: "rejects malformed model_change payload",
      input: [event("model_change", { payload: { previousModel: "", newModel: "gpt-5.1" } })],
    },
    {
      name: "rejects unknown model_change payload field",
      input: [
        event("model_change", {
          payload: { previousModel: "gpt-5", newModel: "gpt-5.1", surprise: true },
        }),
      ],
    },
    {
      name: "rejects malformed thinking_level_change payload",
      input: [event("thinking_level_change", { payload: { previousLevel: "medium" } })],
    },
    {
      name: "rejects unknown thinking_level_change payload field",
      input: [
        event("thinking_level_change", {
          payload: { previousLevel: "medium", newLevel: "high", surprise: true },
        }),
      ],
    },
    {
      name: "rejects malformed tool_call payload",
      input: [event("tool_call", { payload: { toolCallId: "call-1", toolName: "read", arguments: [] } })],
    },
    {
      name: "rejects unknown tool_call payload field",
      input: [
        event("tool_call", {
          payload: { toolCallId: "call-1", toolName: "read", arguments: {}, surprise: true },
        }),
      ],
    },
    {
      name: "rejects malformed tool_result payload",
      input: [event("tool_result", { payload: { toolCallId: "call-1", content: "result", isError: "no" } })],
    },
    {
      name: "rejects unknown tool_result payload field",
      input: [
        event("tool_result", {
          payload: { toolCallId: "call-1", content: "result", surprise: true },
        }),
      ],
    },
    // turn_end is a closed optional struct (schema v5 / D1): empty stays valid;
    // unknown keys reject with the allowed-field list (not the old mandatory-empty
    // surface). Valid host-fact payloads are accepted.
    { name: "rejects unknown turn_end payload field", input: [event("turn_end", { payload: { text: "extra" } })] },
    {
      name: "accepts empty turn_end payload",
      input: [event("turn_end", { payload: {} })],
    },
    {
      name: "accepts turn_end host-fact payload",
      input: [
        event("turn_end", {
          payload: {
            outcome: "aborted",
            outcomeReason: "user cancelled",
            startedAt: "2026-07-01T12:00:00.000Z",
            endedAt: "2026-07-01T12:00:04.250Z",
          },
        }),
      ],
    },
    {
      name: "accepts assistant_text with providerUsage object",
      input: [event("assistant_text", { payload: { text: "done", providerUsage: { input_tokens: 12 } } })],
    },
    {
      name: "rejects a whole batch at the first invalid event",
      input: [event("user_prompt"), event("assistant_text"), event("assistant_thinking", { actor: "" })],
    },
    {
      name: "rejects a mixed valid/duplicate/invalid-shaped batch at the invalid index",
      input: [event("tool_call"), event("tool_call"), event("turn_end", { payload: { bad: true } })],
    },
  );

  return cases;
}

export function threadRefCases(): ValidationCase[] {
  return [
    { name: "accepts threadId ref", input: { threadId: "thread-1" } },
    { name: "accepts threadId ref with registryPath", input: { threadId: "thread-1", registryPath: "registry.db" } },
    { name: "accepts filePath ref", input: { filePath: "thread.db" } },
    { name: "rejects unknown thread ref field", input: { filePath: "thread.db", surprise: true } },
    { name: "rejects empty threadId", input: { threadId: "" } },
    { name: "rejects empty filePath", input: { filePath: "" } },
    { name: "rejects malformed registryPath", input: { threadId: "thread-1", registryPath: 1 } },
    { name: "rejects null ref", input: null },
    { name: "rejects array ref", input: [] },
    { name: "rejects string ref", input: "thread.db" },
  ];
}
