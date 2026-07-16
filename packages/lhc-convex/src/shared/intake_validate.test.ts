// @vitest-environment node

import { describe, expect, test } from "vitest";
import {
  EVENT_KINDS,
  validateEvents as validateConvexEvents,
  validateThreadRef as validateConvexThreadRef,
} from "./intake_validate.js";

type ValidatorModule = {
  validateEvents: typeof validateConvexEvents;
  validateThreadRef: typeof validateConvexThreadRef;
};

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

interface ValidationCase {
  name: string;
  input: unknown;
}

function eventCases(): ValidationCase[] {
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
    { name: "rejects non-empty turn_end payload", input: [event("turn_end", { payload: { text: "extra" } })] },
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

function threadRefCases(): ValidationCase[] {
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

describe("frozen intake validation differential", () => {
  test("acceptance, codes, reasons, and event indexes are byte-for-byte equivalent", async () => {
    const frozenModulePath = new URL("../../../lhc/src/intake-stream/internal/validate.ts", import.meta.url).href;
    const frozen = (await import(frozenModulePath)) as ValidatorModule;
    const mismatches: Array<Record<string, unknown>> = [];

    for (const validationCase of eventCases()) {
      const expected = frozen.validateEvents(validationCase.input);
      const actual = validateConvexEvents(validationCase.input);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push({ case: validationCase.name, expected, actual });
      }
    }
    for (const validationCase of threadRefCases()) {
      const expected = frozen.validateThreadRef(validationCase.input);
      const actual = validateConvexThreadRef(validationCase.input);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push({ case: validationCase.name, expected, actual });
      }
    }

    expect(mismatches).toEqual([]);
  });
});
