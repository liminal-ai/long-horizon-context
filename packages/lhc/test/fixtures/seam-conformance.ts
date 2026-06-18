// Parameterized seam-contract assertions (Epic 05 DD-13): the same helpers
// run against the scripted fakes (TC-1.2) and, unchanged, against the real
// OpenRouter host (TC-4.3) — shared assertion code, never duplicated tests.
// Framework-agnostic on purpose: plain node:assert throws surface in vitest
// and in any future runner identically.
import assert from "node:assert/strict";
import { initLhc, type Derivation, type Lhc } from "../../src/index.js";
import {
  DERIVATION_TYPES,
  INFERENCE_DERIVATION_TYPES,
  type InferenceDerivationType,
} from "./model-call.js";
import type {
  ModelAssignment,
  ModelCall,
  ModelCallInput,
} from "../../src/shared-tech/inference-types.js";
import { readDerivedForms } from "./threads.js";
import { validEvent, type TempStore } from "./index.js";

const FAILURE_KINDS = new Set([
  "rate_limit",
  "timeout",
  "network",
  "empty_output",
  "other",
  "auth",
  "invalid_request",
]);

export function probeInput(overrides: Partial<ModelCallInput> = {}): ModelCallInput {
  return {
    provider: "probe-provider",
    model: "probe-model",
    messages: [
      { role: "system", content: "You answer with one word." },
      { role: "user", content: "Say ok." },
    ],
    ...overrides,
  };
}

// AC-1.2's result contract on one probe call: a ModelCall resolves to either
// `{ ok: true, text }` or `{ ok: false, kind, message }` with `kind` from the
// failure vocabulary. Catches fixture (and real-host) drift from the
// boundary contract.
export async function assertModelCallContract(
  call: ModelCall,
  probe: ModelCallInput = probeInput(),
): Promise<void> {
  const result = await call(probe);
  assert.ok(
    typeof result === "object" && result !== null,
    "ModelCall must resolve to a result object",
  );
  if (result.ok === true) {
    assert.equal(typeof result.text, "string", "success result must carry string text");
  } else if (result.ok === false) {
    assert.ok(
      FAILURE_KINDS.has(result.kind),
      `failure kind "${String(result.kind)}" is not in the failure vocabulary`,
    );
    assert.equal(typeof result.message, "string", "failure result must carry a string message");
  } else {
    assert.fail("ModelCall result must discriminate on a boolean ok");
  }
}

export interface RoutingRunResult {
  sdk: Lhc;
  filePath: string;
  derivations: Derivation[];
  log: ModelCallInput[];
}

async function seedAllSevenKinds(sdk: Lhc, store: TempStore): Promise<string> {
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  assert.ok(created.ok, "conformance fixture: thread creation failed");
  // Turn 1 carries a tool run (smoothing, tool-call/result summaries,
  // rendering, projection); turn 2 exists so turn 1's chunk closes under the
  // tiny target policy and the two chunk summaries enqueue.
  const result = await sdk.intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "please inspect the fixture file" } }),
    validEvent("tool_call", {
      payload: {
        toolCallId: "call-seam-1",
        toolName: "read_file",
        arguments: { path: "fixture.txt" },
      },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-seam-1", content: "contents of fixture.txt", isError: false },
    }),
    validEvent("assistant_text", { payload: { text: "the fixture file holds fixture text" } }),
    validEvent("turn_end"),
    validEvent("user_prompt", { payload: { text: "thanks, now summarize it" } }),
    validEvent("assistant_text", { payload: { text: "summarized" } }),
    validEvent("turn_end"),
  ]);
  assert.ok(result.ok, "conformance fixture: intake batch failed");
  return filePath;
}

// TC-1.2's routing assertions, extracted so TC-4.3 runs them against the
// real host unchanged: construct an SDK on the inference path, drive all
// derivation kinds through a real intake → drain, and assert (1) every kind
// lands ready, (2) every call that crossed the boundary carried exactly one
// inference kind's assigned provider/model routing keys, (3) each inference
// kind's lane was exercised, and (4) every messages value is single-turn
// shape — system and user roles only, string content (AC-1.2, AC-1.4).
export async function assertRoutingThroughSdk(
  call: ModelCall,
  assignments: Record<InferenceDerivationType, ModelAssignment>,
  store: TempStore,
): Promise<RoutingRunResult> {
  const log: ModelCallInput[] = [];
  const logged: ModelCall = (input) => {
    log.push(structuredClone(input));
    return call(input);
  };
  const sdk = initLhc({
    inference: { call: logged, assignments },
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    // Tiny target: each placed turn crosses it, so the prior turn's chunk
    // closes during the drain and the chunk-summary kinds run too.
    chunkPolicy: { targetProjectedTokens: 5, maxProjectedTokens: 4400 },
  });
  const filePath = await seedAllSevenKinds(sdk, store);

  const drained = await sdk.work.drain({ filePath });
  assert.ok(drained.ok, "conformance drain failed");
  assert.equal(drained.value.stoppedBecause, "empty", "conformance drain left work behind");
  assert.equal(drained.value.remaining, 0, "conformance drain left items remaining");

  const forms = readDerivedForms(filePath);
  for (const kind of DERIVATION_TYPES) {
    assert.ok(
      forms.some((form) => form.derivationType === kind && form.state === "ready"),
      `expected at least one ready ${kind} form after the drain`,
    );
  }

  assert.ok(log.length > 0, "no calls crossed the ModelCall boundary");
  for (const input of log) {
    const matched = INFERENCE_DERIVATION_TYPES.filter(
      (kind) =>
        assignments[kind].provider === input.provider && assignments[kind].model === input.model,
    );
    assert.ok(
      matched.length > 0,
      `call carried provider/model "${input.provider}"/"${input.model}" matching no kind's assignment`,
    );
    assert.ok(input.messages.length > 0, "a call crossed the boundary with no messages");
    assert.ok(
      input.messages.some((message) => message.role === "user"),
      "single-turn shape requires a user message",
    );
    for (const message of input.messages) {
      assert.ok(
        message.role === "system" || message.role === "user",
        `message role "${String(message.role)}" is outside the single-turn vocabulary`,
      );
      assert.equal(typeof message.content, "string", "message content must be a string");
    }
  }
  for (const kind of INFERENCE_DERIVATION_TYPES) {
    assert.ok(
      log.some(
        (input) =>
          input.provider === assignments[kind].provider && input.model === assignments[kind].model,
      ),
      `no boundary call carried ${kind}'s assigned provider/model lane`,
    );
  }
  return { sdk, filePath, derivations: forms, log };
}
