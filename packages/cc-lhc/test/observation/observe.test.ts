import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens, type MessageEventInput, TOKEN_ESTIMATOR_ID } from "lhc";
import { describe, expect, it } from "vitest";
import { BUILTIN_CONTEXT_POLICY, CONTEXT_WINDOW_NOT_YET_OBSERVED } from "../../src/governor/config.js";
import { decideGovernor } from "../../src/governor/decide.js";
import { applyGovernorLifecycleBatch, createGovernorRuntimeState } from "../../src/governor/observe-state.js";
import { providerContextFromUsage } from "../../src/governor/provider-context.js";
import type { ResolvedContextPolicy } from "../../src/governor/types.js";
import {
  composeEstimateSources,
  createPostMeasurementEstimateFold,
  estimateAcceptedEvent,
  HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
  hostEstimateFromCanonicalBytes,
  MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE,
  mergeEstimateSource,
  PENDING_PROMPT_ESTIMATE_SOURCE,
  PROVIDER_OUTPUT_ESTIMATE_SOURCE,
  pendingPromptEstimate,
  postMeasurementEstimateFromEvents,
  preLaunchEstimate,
  USER_PROMPT_ESTIMATE_SOURCE,
} from "../../src/observation/estimate.js";
import {
  createTurnFoldState,
  isClaudePromptTooLongRejection,
  observeRolloutLine,
  postMeasurementAddFromAcceptedEvents,
} from "../../src/observation/observe.js";
import { createSamplingDedupeState } from "../../src/observation/sampling.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "rollout-samples-slice1.jsonl");

function loadFixtures(): RolloutLineItem[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RolloutLineItem);
}

function byUuid(items: RolloutLineItem[], uuid: string): RolloutLineItem {
  const found = items.find((item) => item.uuid === uuid);
  if (found === undefined) throw new Error(`missing uuid ${uuid}`);
  return found;
}

describe("observeRolloutLine", () => {
  const fixtures = loadFixtures();

  it("captures empty-but-signed thinking with opaque signature and model", () => {
    const item = byUuid(fixtures, "sanitized-uuid-thinking");
    const result = observeRolloutLine(item);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventKind).toBe("assistant_thinking");
  });

  it("preserves empty unsigned thinking canonically", () => {
    const husk: RolloutLineItem = {
      type: "assistant",
      uuid: "empty-unsigned",
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "thinking", thinking: "", signature: "" }],
      },
    };
    const result = observeRolloutLine(husk);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventKind).toBe("assistant_thinking");
  });

  it("preserves native block order and stable native block-index idempotency keys", () => {
    const item: RolloutLineItem = {
      type: "assistant",
      uuid: "order-uuid",
      message: {
        role: "assistant",
        model: "m",
        content: [
          { type: "text", text: "first" },
          { type: "thinking", thinking: "mid", signature: "SIG" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
    };
    const result = observeRolloutLine(item);
    expect(result.events.map((e) => e.eventKind)).toEqual(["assistant_text", "assistant_thinking", "tool_call"]);
  });

  it("emits one sampling_observed with final usage after split model-only then usage (end_turn)", () => {
    const dedupe = createSamplingDedupeState();
    const thinking: RolloutLineItem = {
      type: "assistant",
      uuid: "s1",
      requestId: "req_split_1",
      message: {
        role: "assistant",
        id: "msg_split",
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "", signature: "SIG" }],
        usage: { input_tokens: 1, output_tokens: 3 },
      },
    };
    const text: RolloutLineItem = {
      type: "assistant",
      uuid: "s2",
      requestId: "req_split_1",
      message: {
        role: "assistant",
        id: "msg_split",
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 192 },
      },
    };
    const r1 = observeRolloutLine(thinking, 0, { samplingDedupe: dedupe });
    const r2 = observeRolloutLine(text, 1, { samplingDedupe: dedupe });
    expect(r1.lifecycle.filter((s) => s.kind === "sampling_observed")).toHaveLength(0);
    // thinking-only + end_turn is not turn_settled
    expect(r1.lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(0);
    const sampling = r2.lifecycle.filter((s) => s.kind === "sampling_observed");
    expect(sampling).toHaveLength(1);
    expect(sampling[0]).toMatchObject({
      samplingId: "req:req_split_1",
      providerUsage: { output_tokens: 192 },
    });
    expect(r2.lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(1);
    const kinds = r2.lifecycle.map((s) => s.kind);
    expect(kinds.indexOf("sampling_observed")).toBeLessThan(kinds.indexOf("turn_settled"));
  });

  it("tool-use split: one sampling_observed; turn stays open (no turn_settled)", () => {
    const dedupe = createSamplingDedupeState();
    const think: RolloutLineItem = {
      type: "assistant",
      uuid: "t1",
      requestId: "req_tool",
      message: {
        role: "assistant",
        id: "msg_tool",
        model: "m",
        stop_reason: "tool_use",
        content: [{ type: "thinking", thinking: "", signature: "S" }],
        usage: { output_tokens: 2 },
      },
    };
    const tool: RolloutLineItem = {
      type: "assistant",
      uuid: "t2",
      requestId: "req_tool",
      message: {
        role: "assistant",
        id: "msg_tool",
        model: "m",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        usage: { output_tokens: 40 },
      },
    };
    const r1 = observeRolloutLine(think, 0, { samplingDedupe: dedupe });
    const r2 = observeRolloutLine(tool, 1, { samplingDedupe: dedupe });
    expect(r1.lifecycle.filter((s) => s.kind === "sampling_observed")).toHaveLength(0);
    expect(r2.lifecycle.filter((s) => s.kind === "sampling_observed")).toHaveLength(1);
    expect(r2.lifecycle.filter((s) => s.kind === "sampling_observed")[0]).toMatchObject({
      providerUsage: { output_tokens: 40 },
    });
    expect(r2.lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(0);
    // Assistant tool_use is an open-state assertion, not a turn_opened edge.
    expect(r2.lifecycle.some((s) => s.kind === "turn_opened")).toBe(false);
  });

  it("emits turn_opened only on user/tool_result edges; one turn_settled per open→close", () => {
    const dedupe = createSamplingDedupeState();
    const fold = createTurnFoldState();
    const user: RolloutLineItem = {
      type: "user",
      uuid: "u-open",
      message: { role: "user", content: "go" },
    };
    const think: RolloutLineItem = {
      type: "assistant",
      uuid: "a-think",
      requestId: "req_edge",
      message: {
        role: "assistant",
        id: "msg_edge",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "", signature: "S" }],
        usage: { output_tokens: 1 },
      },
    };
    const text1: RolloutLineItem = {
      type: "assistant",
      uuid: "a-text1",
      requestId: "req_edge",
      message: {
        role: "assistant",
        id: "msg_edge",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "part1" }],
        usage: { output_tokens: 10 },
      },
    };
    const text2: RolloutLineItem = {
      type: "assistant",
      uuid: "a-text2",
      requestId: "req_edge",
      message: {
        role: "assistant",
        id: "msg_edge",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "part2" }],
        usage: { output_tokens: 12 },
      },
    };
    const opts = { samplingDedupe: dedupe, turnFold: fold };
    const rUser = observeRolloutLine(user, 0, opts);
    const rThink = observeRolloutLine(think, 1, opts);
    const rText1 = observeRolloutLine(text1, 2, opts);
    const rText2 = observeRolloutLine(text2, 3, opts);
    expect(rUser.lifecycle.filter((s) => s.kind === "turn_opened")).toHaveLength(1);
    expect(rThink.lifecycle.filter((s) => s.kind === "turn_opened")).toHaveLength(0);
    expect(rThink.lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(0);
    expect(rText1.lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(1);
    expect(rText1.lifecycle.filter((s) => s.kind === "sampling_observed")).toHaveLength(1);
    // Second terminal text under same request: no second settle, no second sampling.
    expect(rText2.lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(0);
    expect(rText2.lifecycle.filter((s) => s.kind === "sampling_observed")).toHaveLength(0);
  });

  it("tool-use split with fold: no turn_opened; turn stays open for tool_result continuation", () => {
    const fold = createTurnFoldState();
    const dedupe = createSamplingDedupeState();
    const user: RolloutLineItem = {
      type: "user",
      uuid: "u0",
      message: { role: "user", content: "run" },
    };
    const think: RolloutLineItem = {
      type: "assistant",
      uuid: "t1",
      requestId: "req_tool2",
      message: {
        role: "assistant",
        id: "msg_tool2",
        model: "m",
        stop_reason: "tool_use",
        content: [{ type: "thinking", thinking: "", signature: "S" }],
      },
    };
    const tool: RolloutLineItem = {
      type: "assistant",
      uuid: "t2",
      requestId: "req_tool2",
      message: {
        role: "assistant",
        id: "msg_tool2",
        model: "m",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        usage: { output_tokens: 40 },
      },
    };
    const opts = { samplingDedupe: dedupe, turnFold: fold };
    expect(observeRolloutLine(user, 0, opts).lifecycle.filter((s) => s.kind === "turn_opened")).toHaveLength(1);
    observeRolloutLine(think, 1, opts);
    const rTool = observeRolloutLine(tool, 2, opts);
    expect(rTool.lifecycle.filter((s) => s.kind === "turn_opened")).toHaveLength(0);
    expect(rTool.lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(0);
    expect(rTool.lifecycle.filter((s) => s.kind === "sampling_observed")).toHaveLength(1);
    expect(fold.open).toBe(true);
  });

  it("does not merge distinct requestIds (retries)", () => {
    const dedupe = createSamplingDedupeState();
    const a: RolloutLineItem = {
      type: "assistant",
      uuid: "r1",
      requestId: "req_a",
      message: {
        role: "assistant",
        id: "msg_same",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "a" }],
        usage: { output_tokens: 1 },
      },
    };
    const b: RolloutLineItem = {
      type: "assistant",
      uuid: "r2",
      requestId: "req_b",
      message: {
        role: "assistant",
        id: "msg_same",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "b" }],
        usage: { output_tokens: 2 },
      },
    };
    const ra = observeRolloutLine(a, 0, { samplingDedupe: dedupe });
    const rb = observeRolloutLine(b, 1, { samplingDedupe: dedupe });
    const ids = [...ra.lifecycle, ...rb.lifecycle]
      .filter((s) => s.kind === "sampling_observed")
      .map((s) => (s.kind === "sampling_observed" ? s.samplingId : ""));
    expect(ids).toEqual(["req:req_a", "req:req_b"]);
  });

  it("emits mismatch and degrade exactly once each (exact cardinality)", () => {
    const foreign = byUuid(fixtures, "conflict-session-uuid");
    const result = observeRolloutLine(foreign, 0, {
      expectedSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      generation: 3,
    });
    expect(result.lifecycle).toEqual([
      {
        kind: "session_mismatch_observed",
        expected: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        observed: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      },
      {
        kind: "capture_degraded",
        reason: "session_mismatch:ffffffff-ffff-ffff-ffff-ffffffffffff",
        generation: 3,
      },
    ]);
  });

  it("accepts fork/resume dual fields without mismatch", () => {
    const dual = byUuid(fixtures, "fork-dual-session-line");
    const expected = "03c76ca8-427f-4a12-82c2-74496ed92c02";
    const result = observeRolloutLine(dual, 0, { expectedSessionId: expected });
    expect(result.events).toHaveLength(1);
    expect(result.lifecycle.some((s) => s.kind === "session_mismatch_observed")).toBe(false);
  });

  it("classifies agent-name as meta", () => {
    const item = byUuid(fixtures, "agent-name-meta");
    const result = observeRolloutLine(item);
    expect(result.stats.meta).toBe(1);
    expect(result.stats.unknown).toBe(0);
  });

  it("counts unknown top-level host chrome without degrading capture", () => {
    const weird: RolloutLineItem = { type: "totally-unknown-record-type", foo: 1 };
    const result = observeRolloutLine(weird, 4, { generation: 2 });
    expect(result.stats.unknown).toBe(1);
    expect(result.lifecycle).not.toContainEqual({
      kind: "capture_degraded",
      reason: "unknown_shape:type=totally-unknown-record-type",
      generation: 2,
    });
  });

  it("degrades on unknown conversational content that could be omitted", () => {
    const weird = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "future-dialogue-block", value: "not mapped" }] },
    } as unknown as RolloutLineItem;
    const result = observeRolloutLine(weird, 4, { generation: 2 });
    expect(result.lifecycle).toContainEqual({
      kind: "capture_degraded",
      reason: "unknown_shape:type=assistant",
      generation: 2,
    });
  });

  it("production path: completed sampling emits provider output estimate; tool results accumulate; dedupe does not inflate", () => {
    const dedupe = createSamplingDedupeState();
    const fold = createTurnFoldState();
    const estimateFold = createPostMeasurementEstimateFold();
    const opts = { samplingDedupe: dedupe, turnFold: fold, estimateFold };

    const user: RolloutLineItem = {
      type: "user",
      uuid: "est-u1",
      message: { role: "user", content: "please run" },
    };
    const assistant: RolloutLineItem = {
      type: "assistant",
      uuid: "est-a1",
      requestId: "req_est",
      message: {
        role: "assistant",
        id: "msg_est",
        model: "m",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_est", name: "Bash", input: { command: "echo hi" } }],
        usage: {
          input_tokens: 350_000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 8_000,
        },
      },
    };
    // Large tool result so host byte estimate is non-zero (bytes/4).
    const toolBody = "x".repeat(40_000);
    const toolResult: RolloutLineItem = {
      type: "user",
      uuid: "est-tr1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_est", content: toolBody }],
      },
    };
    const sidechain: RolloutLineItem = {
      type: "assistant",
      uuid: "est-side",
      isSidechain: true,
      message: {
        role: "assistant",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "sidechain noise ".repeat(1000) }],
        usage: { input_tokens: 999_999, output_tokens: 50_000 },
      },
    };

    observeRolloutLine(user, 0, opts);
    const rAsst = observeRolloutLine(assistant, 1, opts);
    expect(rAsst.lifecycle.some((s) => s.kind === "sampling_observed")).toBe(true);
    const estAfterSampling = rAsst.lifecycle.filter((s) => s.kind === "post_measurement_estimate");
    expect(estAfterSampling).toHaveLength(1);
    expect(estAfterSampling[0]).toMatchObject({
      kind: "post_measurement_estimate",
      tokens: 8_000,
      source: PROVIDER_OUTPUT_ESTIMATE_SOURCE,
      mode: "set",
    });

    const rTool = observeRolloutLine(toolResult, 2, opts);
    const addEst = rTool.lifecycle.filter((s) => s.kind === "post_measurement_estimate");
    expect(addEst).toHaveLength(1);
    expect(addEst[0]).toMatchObject({
      kind: "post_measurement_estimate",
      source: HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
      mode: "add",
    });
    expect((addEst[0] as { tokens: number }).tokens).toBe(Math.floor(40_000 / 4));

    // Sidechain must not emit sampling or estimate growth.
    const rSide = observeRolloutLine(sidechain, 3, opts);
    expect(rSide.lifecycle.filter((s) => s.kind === "sampling_observed")).toHaveLength(0);
    expect(rSide.lifecycle.filter((s) => s.kind === "post_measurement_estimate")).toHaveLength(0);

    // Replay of the same completed assistant (dedupe) must not re-seed estimate.
    const rReplay = observeRolloutLine(assistant, 4, opts);
    expect(rReplay.lifecycle.filter((s) => s.kind === "sampling_observed")).toHaveLength(0);
    expect(rReplay.lifecycle.filter((s) => s.kind === "post_measurement_estimate")).toHaveLength(0);

    // Governor fold: real watcher lifecycle moves pressure across the trigger.
    const resolved: ResolvedContextPolicy = {
      policy: { ...BUILTIN_CONTEXT_POLICY, upperBoundTokens: 360_000 },
      sources: Object.fromEntries(
        Object.keys(BUILTIN_CONTEXT_POLICY).map((k) => [k, "session"]),
      ) as ResolvedContextPolicy["sources"],
      fallbacks: [],
      contextWindow: CONTEXT_WINDOW_NOT_YET_OBSERVED,
    };
    const lifecycle = [
      ...rAsst.lifecycle.filter((s) => s.kind === "sampling_observed" || s.kind === "post_measurement_estimate"),
      ...rTool.lifecycle.filter((s) => s.kind === "post_measurement_estimate"),
      { kind: "turn_settled" as const, reason: "end_turn" as const },
    ];
    // turn_opened first so open-turn classification is honest
    const rGov = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({ captureGeneration: 1 }),
      [{ kind: "turn_opened", reason: "user_prompt" }, ...lifecycle],
      resolved,
    );
    const settled = rGov.observes.filter((o) => o.observePhase === "settled_seam")[0]!;
    // provider 350k + output 8k + tool bytes/4 (10k) = 368k >= 360k
    expect(settled.providerContextTotal).toBe(350_000);
    expect(settled.postMeasurementEstimate.tokens).toBe(8_000 + 10_000);
    expect(settled.pressure.nextRequestPressureTokens).toBe(368_000);
    expect(settled.decision).toBe("would_compact");
    expect(settled.wouldMutate).toBe(true);
  });

  it("host-byte fallback when output_tokens missing; newer sampling resets estimate", () => {
    const dedupe = createSamplingDedupeState();
    const estimateFold = createPostMeasurementEstimateFold();
    const fold = createTurnFoldState();
    const opts = { samplingDedupe: dedupe, turnFold: fold, estimateFold };

    const a1: RolloutLineItem = {
      type: "assistant",
      uuid: "hb1",
      requestId: "req_hb1",
      message: {
        role: "assistant",
        id: "msg_hb1",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "abcd".repeat(100) }], // 400 bytes → 100 tokens
        usage: { input_tokens: 10_000 },
      },
    };
    const r1 = observeRolloutLine(a1, 0, opts);
    const e1 = r1.lifecycle.find((s) => s.kind === "post_measurement_estimate");
    expect(e1).toMatchObject({
      source: HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
      mode: "set",
      tokens: 100,
    });

    const a2: RolloutLineItem = {
      type: "assistant",
      uuid: "hb2",
      requestId: "req_hb2",
      message: {
        role: "assistant",
        id: "msg_hb2",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "z" }],
        usage: { input_tokens: 11_000, output_tokens: 7 },
      },
    };
    const r2 = observeRolloutLine(a2, 1, opts);
    const e2 = r2.lifecycle.find((s) => s.kind === "post_measurement_estimate");
    expect(e2).toMatchObject({
      source: PROVIDER_OUTPUT_ESTIMATE_SOURCE,
      mode: "set",
      tokens: 7,
    });
  });
});

describe("pre-launch estimate: what the next request carries that no provider reading covers", () => {
  it("a pending prompt is sized by packaged core LHC estimateTokens, labelled with estimator identity", () => {
    const text = "x".repeat(400);
    expect(pendingPromptEstimate(text)).toEqual({
      tokens: estimateTokens(text),
      source: PENDING_PROMPT_ESTIMATE_SOURCE,
      domain: "source_labelled_estimate",
    });
    expect(PENDING_PROMPT_ESTIMATE_SOURCE).toBe(`pending_prompt:${TOKEN_ESTIMATOR_ID}`);
    expect(pendingPromptEstimate("")).toMatchObject({ tokens: 0 });
  });

  it("pending one-shot prompt estimation is not the captured-content bytes/4 heuristic", () => {
    const prompt = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "burnin-defect-001-prompt.txt"),
      "utf8",
    );
    expect(Buffer.byteLength(prompt, "utf8")).toBe(104_263);
    expect(Math.floor(Buffer.byteLength(prompt, "utf8") / 4)).toBe(26_065);
    expect(pendingPromptEstimate(prompt).tokens).toBe(66_025);
    expect(pendingPromptEstimate(prompt).tokens).toBe(estimateTokens(prompt));
    expect(pendingPromptEstimate(prompt).source).toContain(TOKEN_ESTIMATOR_ID);
  });

  it("captured growth and the pending prompt add up, and the label names both", () => {
    const growth = hostEstimateFromCanonicalBytes(800);
    const prompt = "y".repeat(400);
    const estimate = preLaunchEstimate(growth, prompt);
    expect(estimate.tokens).toBe(growth.tokens + estimateTokens(prompt));
    expect(estimate.source).toBe(`${HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE}+${PENDING_PROMPT_ESTIMATE_SOURCE}`);
  });

  it("with nothing captured since the last reading, the estimate is the prompt alone", () => {
    const prompt = "z".repeat(40);
    const estimate = preLaunchEstimate(hostEstimateFromCanonicalBytes(0), prompt);
    expect(estimate).toMatchObject({
      tokens: estimateTokens(prompt),
      source: PENDING_PROMPT_ESTIMATE_SOURCE,
    });
  });
});

const BURNIN_PROMPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "burnin-defect-001-prompt.txt"),
  "utf8",
);

function userPromptEvent(text: string): MessageEventInput {
  return {
    eventKind: "user_prompt",
    idempotencyKey: "user:1",
    actor: "user",
    harness: "cc",
    payload: { text },
  };
}

function toolResultEvent(content: string): MessageEventInput {
  return {
    eventKind: "tool_result",
    idempotencyKey: "tool:1",
    actor: "tool",
    harness: "cc",
    payload: { toolCallId: "toolu_1", content },
  };
}

function promptTooLongApiError(): RolloutLineItem {
  return {
    type: "assistant",
    uuid: "api-err",
    error: "invalid_request",
    isApiErrorMessage: true,
    message: {
      role: "assistant",
      id: "msg_api_err",
      model: "<synthetic>",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "Prompt is too long" }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function syntheticNoResponse(): RolloutLineItem {
  return {
    type: "assistant",
    uuid: "synth-nr",
    isApiErrorMessage: false,
    message: {
      role: "assistant",
      model: "<synthetic>",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "No response requested." }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

function burninPolicy(): ResolvedContextPolicy {
  return {
    policy: {
      ...BUILTIN_CONTEXT_POLICY,
      lowerBoundTokens: 100_000,
      upperBoundTokens: 200_000,
      minRunwayTokens: 50_000,
      profile: "balanced",
    },
    sources: Object.fromEntries(
      Object.keys(BUILTIN_CONTEXT_POLICY).map((k) => [k, "session"]),
    ) as ResolvedContextPolicy["sources"],
    fallbacks: [],
    contextWindow: CONTEXT_WINDOW_NOT_YET_OBSERVED,
  };
}

describe("accepted user_prompt post-measurement uses LHC estimateTokens", () => {
  it("shared helper: user events are 66025, not bytes/4; tools stay bytes/4", () => {
    expect(Buffer.byteLength(BURNIN_PROMPT, "utf8")).toBe(104_263);
    const user = estimateAcceptedEvent(userPromptEvent(BURNIN_PROMPT));
    expect(user.tokens).toBe(66_025);
    expect(user.tokens).toBe(estimateTokens(BURNIN_PROMPT));
    expect(user.tokens).not.toBe(26_065);
    expect(user.source).toBe(USER_PROMPT_ESTIMATE_SOURCE);
    expect(user.source).toContain(TOKEN_ESTIMATOR_ID);

    const tool = estimateAcceptedEvent(toolResultEvent("T".repeat(8_000)));
    expect(tool.tokens).toBe(2_000);
    expect(tool.source).toBe(HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE);

    const runtime: MessageEventInput = {
      eventKind: "runtime_note",
      idempotencyKey: "rt:1",
      actor: "system",
      harness: "cc",
      payload: { text: "R".repeat(400) },
    };
    expect(estimateAcceptedEvent(runtime).tokens).toBe(100);

    const deferred = postMeasurementAddFromAcceptedEvents([userPromptEvent(BURNIN_PROMPT)]);
    expect(deferred).toMatchObject({
      kind: "post_measurement_estimate",
      tokens: 66_025,
      source: USER_PROMPT_ESTIMATE_SOURCE,
      mode: "add",
    });
    expect(postMeasurementEstimateFromEvents([userPromptEvent(BURNIN_PROMPT)]).tokens).toBe(66_025);
    expect(postMeasurementAddFromAcceptedEvents([toolResultEvent("T".repeat(8_000))])).toMatchObject({
      tokens: 2_000,
      source: HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
      mode: "add",
    });

    const mixedUserTool = postMeasurementAddFromAcceptedEvents([
      userPromptEvent(BURNIN_PROMPT),
      toolResultEvent("T".repeat(8_000)),
    ]);
    expect(mixedUserTool).toMatchObject({
      kind: "post_measurement_estimate",
      tokens: 66_025 + 2_000,
      mode: "add",
    });
    expect(mixedUserTool?.source).toBe(
      composeEstimateSources([USER_PROMPT_ESTIMATE_SOURCE, HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE]),
    );
    expect(mixedUserTool?.source).toBe(`${HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE}+${USER_PROMPT_ESTIMATE_SOURCE}`);
    expect(mixedUserTool?.source).not.toBe(MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE);
    expect(mixedUserTool?.source).not.toContain("provider_output");
    expect(mergeEstimateSource(HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE, USER_PROMPT_ESTIMATE_SOURCE, 1)).toBe(
      mixedUserTool?.source,
    );
    expect(mergeEstimateSource(PROVIDER_OUTPUT_ESTIMATE_SOURCE, HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE, 1)).toBe(
      MIXED_POST_MEASUREMENT_ESTIMATE_SOURCE,
    );
  });

  it("immediate observe mode:add and deferred accepted-event add agree on the exact prompt", () => {
    const estimateFold = createPostMeasurementEstimateFold();
    estimateFold.hasAuthoritativeSampling = true;
    const userItem: RolloutLineItem = {
      type: "user",
      uuid: "u-burnin",
      message: { role: "user", content: BURNIN_PROMPT },
    };
    const immediate = observeRolloutLine(userItem, 0, {
      estimateFold,
      samplingDedupe: createSamplingDedupeState(),
      turnFold: createTurnFoldState(),
    });
    const add = immediate.lifecycle.find((s) => s.kind === "post_measurement_estimate");
    expect(add).toMatchObject({
      kind: "post_measurement_estimate",
      tokens: 66_025,
      source: USER_PROMPT_ESTIMATE_SOURCE,
      mode: "add",
    });
    expect(postMeasurementAddFromAcceptedEvents(immediate.events)).toMatchObject({
      tokens: 66_025,
      source: USER_PROMPT_ESTIMATE_SOURCE,
      mode: "add",
    });
  });

  it("valid 164208 + accepted user 66025 + all-zero API error preserves growth; next tiny prelaunch stays at trigger", () => {
    const resolved = burninPolicy();
    const estimateFold = createPostMeasurementEstimateFold();
    const samplingDedupe = createSamplingDedupeState();
    const turnFold = createTurnFoldState();
    const opts = { estimateFold, samplingDedupe, turnFold };

    const assistant: RolloutLineItem = {
      type: "assistant",
      uuid: "prior",
      requestId: "req_prior",
      message: {
        role: "assistant",
        id: "msg_prior",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 164_208,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    };
    const userItem: RolloutLineItem = {
      type: "user",
      uuid: "u-burnin",
      message: { role: "user", content: BURNIN_PROMPT },
    };

    const rAsst = observeRolloutLine(assistant, 0, opts);
    const rUser = observeRolloutLine(userItem, 1, opts);
    const rErr = observeRolloutLine(promptTooLongApiError(), 2, opts);

    expect(
      providerContextFromUsage({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    ).toBeNull();
    expect(rUser.lifecycle.filter((s) => s.kind === "post_measurement_estimate")).toEqual([
      {
        kind: "post_measurement_estimate",
        tokens: 66_025,
        source: USER_PROMPT_ESTIMATE_SOURCE,
        mode: "add",
      },
    ]);
    expect(rErr.lifecycle.filter((s) => s.kind === "post_measurement_estimate")).toHaveLength(0);
    expect(rErr.lifecycle.some((s) => s.kind === "sampling_observed")).toBe(true);

    const folded = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({ captureGeneration: 1 }),
      [...rAsst.lifecycle, ...rUser.lifecycle, ...rErr.lifecycle],
      resolved,
    );
    expect(folded.state.latestProviderContext?.total).toBe(164_208);
    expect(folded.state.postMeasurementEstimate.tokens).toBe(66_025);
    const settled = folded.observes.filter((o) => o.observePhase === "settled_seam").at(-1);
    expect(settled?.providerContextTotal).toBe(164_208);
    expect(settled?.pressure.nextRequestPressureTokens).toBe(230_233);
    expect(settled?.pressure.atOrAboveTrigger).toBe(true);
    expect(settled?.decision).toBe("would_compact");

    const nextPrelaunch = decideGovernor({
      policy: resolved.policy,
      turnOpen: false,
      operationInFlight: false,
      providerContext: folded.state.latestProviderContext,
      providerContextFreshness: "last_known",
      postMeasurementEstimate: preLaunchEstimate(folded.state.postMeasurementEstimate, "hi"),
      contextLimitRejected: folded.state.contextLimitRejected,
    });
    expect(nextPrelaunch.pressure.nextRequestPressureTokens).toBeGreaterThanOrEqual(200_000);
    expect(nextPrelaunch.pressure.nextRequestPressureTokens).toBe(
      164_208 + 66_025 + pendingPromptEstimate("hi").tokens,
    );
    expect(nextPrelaunch.kind).toBe("would_compact");
    // Ephemeral prelaunch of the original prompt is not stored a second time.
    expect(folded.state.postMeasurementEstimate.tokens).not.toBe(66_025 + 66_025);
  });

  it("synthetic all-zero no-response and malformed/missing usage cannot erase pressure", () => {
    const resolved = burninPolicy();
    const seeded = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({ captureGeneration: 1 }),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "req:prior",
          providerUsage: { input_tokens: 164_208, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        {
          kind: "post_measurement_estimate",
          tokens: 66_025,
          source: USER_PROMPT_ESTIMATE_SOURCE,
          mode: "add",
        },
      ],
      resolved,
    );
    expect(seeded.state.postMeasurementEstimate.tokens).toBe(66_025);

    const estimateFold = createPostMeasurementEstimateFold();
    estimateFold.hasAuthoritativeSampling = true;
    const opts = {
      estimateFold,
      samplingDedupe: createSamplingDedupeState(),
      turnFold: createTurnFoldState(),
    };
    const synth = observeRolloutLine(syntheticNoResponse(), 0, opts);
    expect(synth.lifecycle.filter((s) => s.kind === "post_measurement_estimate")).toHaveLength(0);

    const missing: RolloutLineItem = {
      type: "assistant",
      uuid: "missing-usage",
      message: {
        role: "assistant",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "no usage" }],
      },
    };
    const malformed: RolloutLineItem = {
      type: "assistant",
      uuid: "bad-usage",
      requestId: "req_bad",
      message: {
        role: "assistant",
        id: "msg_bad",
        model: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "bad" }],
        usage: { input_tokens: -1 },
      },
    };
    const rMissing = observeRolloutLine(missing, 1, {
      estimateFold: createPostMeasurementEstimateFold(),
      samplingDedupe: createSamplingDedupeState(),
      turnFold: createTurnFoldState(),
    });
    const rMalformed = observeRolloutLine(malformed, 2, {
      estimateFold: createPostMeasurementEstimateFold(),
      samplingDedupe: createSamplingDedupeState(),
      turnFold: createTurnFoldState(),
    });
    expect(rMissing.lifecycle.filter((s) => s.kind === "post_measurement_estimate")).toHaveLength(0);
    expect(rMalformed.lifecycle.filter((s) => s.kind === "post_measurement_estimate")).toHaveLength(0);

    const after = applyGovernorLifecycleBatch(
      seeded.state,
      [...synth.lifecycle, ...rMissing.lifecycle, ...rMalformed.lifecycle],
      resolved,
    );
    expect(after.state.latestProviderContext?.total).toBe(164_208);
    expect(after.state.postMeasurementEstimate.tokens).toBe(66_025);
  });

  it("ordinary nonzero successful sampling still advances provider and resets estimate", () => {
    const resolved = burninPolicy();
    const estimateFold = createPostMeasurementEstimateFold();
    const samplingDedupe = createSamplingDedupeState();
    const turnFold = createTurnFoldState();
    const opts = { estimateFold, samplingDedupe, turnFold };
    observeRolloutLine(
      {
        type: "assistant",
        uuid: "a1",
        requestId: "req1",
        message: {
          role: "assistant",
          id: "m1",
          model: "m",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "a" }],
          usage: { input_tokens: 164_208, output_tokens: 0 },
        },
      },
      0,
      opts,
    );
    observeRolloutLine({ type: "user", uuid: "u1", message: { role: "user", content: BURNIN_PROMPT } }, 1, opts);
    const next = observeRolloutLine(
      {
        type: "assistant",
        uuid: "a2",
        requestId: "req2",
        message: {
          role: "assistant",
          id: "m2",
          model: "m",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "b" }],
          usage: { input_tokens: 170_000, output_tokens: 9 },
        },
      },
      2,
      opts,
    );
    const set = next.lifecycle.find((s) => s.kind === "post_measurement_estimate");
    expect(set).toMatchObject({ mode: "set", tokens: 9, source: PROVIDER_OUTPUT_ESTIMATE_SOURCE });
    const folded = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({ captureGeneration: 1 }),
      [
        { kind: "turn_opened", reason: "user_prompt" },
        {
          kind: "sampling_observed",
          samplingId: "req:1",
          providerUsage: { input_tokens: 164_208 },
        },
        {
          kind: "post_measurement_estimate",
          tokens: 66_025,
          source: USER_PROMPT_ESTIMATE_SOURCE,
          mode: "add",
        },
        ...next.lifecycle.filter((s) => s.kind === "sampling_observed" || s.kind === "post_measurement_estimate"),
      ],
      resolved,
    );
    expect(folded.state.latestProviderContext?.total).toBe(170_000);
    expect(folded.state.postMeasurementEstimate.tokens).toBe(9);
  });
});

describe("exact Claude Prompt is too long classification", () => {
  it("emits contextLimitRejected only for the exact assistant API-error shape", () => {
    const exact = observeRolloutLine(promptTooLongApiError(), 0);
    const sample = exact.lifecycle.find((s) => s.kind === "sampling_observed");
    expect(isClaudePromptTooLongRejection(promptTooLongApiError())).toBe(true);
    expect(sample).toMatchObject({ kind: "sampling_observed", contextLimitRejected: true });

    const variants: RolloutLineItem[] = [
      {
        ...promptTooLongApiError(),
        isApiErrorMessage: false,
      },
      {
        ...promptTooLongApiError(),
        error: "authentication_error",
      },
      {
        type: "assistant",
        uuid: "rate",
        error: "invalid_request",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          id: "msg_rate",
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "Rate limited" }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "assistant",
        uuid: "auth",
        error: "invalid_request",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          id: "msg_auth",
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "authentication_error" }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ];
    for (const item of variants) {
      expect(isClaudePromptTooLongRejection(item), JSON.stringify(item.error)).toBe(false);
      const observed = observeRolloutLine(item, 0);
      const s = observed.lifecycle.find((sig) => sig.kind === "sampling_observed");
      if (s !== undefined && s.kind === "sampling_observed") {
        expect(s.contextLimitRejected).toBeUndefined();
      }
    }
  });
});
