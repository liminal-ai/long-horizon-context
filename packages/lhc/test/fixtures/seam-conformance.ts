import assert from "node:assert/strict";
import { type Derivation, initLhc, type Lhc } from "../../src/index.js";
import type { ModelAssignment, ModelCall, ModelCallInput } from "../../src/shared-tech/inference-types.js";
import { type TempStore, validEvent } from "./index.js";
import { DERIVATION_TYPES, INFERENCE_DERIVATION_TYPES, type InferenceDerivationType } from "./model-call.js";
import { readDerivedForms } from "./threads.js";

const FAILURE_KINDS = new Set(["rate_limit", "timeout", "network", "empty_output", "other", "auth", "invalid_request"]);

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

export async function assertModelCallContract(call: ModelCall, probe: ModelCallInput = probeInput()): Promise<void> {
  const result = await call(probe);
  assert.ok(typeof result === "object" && result !== null, "ModelCall must resolve to a result object");
  if (result.ok === true) {
    assert.equal(typeof result.text, "string", "success result must carry string text");
  } else if (result.ok === false) {
    assert.ok(FAILURE_KINDS.has(result.kind), `failure kind "${String(result.kind)}" is not in the failure vocabulary`);
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
      payload: { toolCallId: "call-seam-1", content: "contents of fixture.txt ".repeat(1500), isError: false },
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
    tokenFamily: "o200k",
    inference: { call: logged, assignments },
    mode: "manual",
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
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
      (kind) => assignments[kind].provider === input.provider && assignments[kind].model === input.model,
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
      log.some((input) => input.provider === assignments[kind].provider && input.model === assignments[kind].model),
      `no boundary call carried ${kind}'s assigned provider/model lane`,
    );
  }
  return { sdk, filePath, derivations: forms, log };
}
