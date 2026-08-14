import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { applyGovernorLifecycleBatch, createGovernorRuntimeState } from "../../src/governor/observe-state.js";
import type { ResolvedContextPolicy } from "../../src/governor/types.js";
import {
  createPostMeasurementEstimateFold,
  HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
  PROVIDER_OUTPUT_ESTIMATE_SOURCE,
} from "../../src/observation/estimate.js";
import { createTurnFoldState, observeRolloutLine } from "../../src/observation/observe.js";
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
      policy: { ...BUILTIN_CONTEXT_POLICY, autoCompact: true, upperBoundTokens: 360_000 },
      sources: Object.fromEntries(
        Object.keys(BUILTIN_CONTEXT_POLICY).map((k) => [k, "session"]),
      ) as ResolvedContextPolicy["sources"],
      armed: true,
      errors: [],
    };
    const lifecycle = [
      ...rAsst.lifecycle.filter((s) => s.kind === "sampling_observed" || s.kind === "post_measurement_estimate"),
      ...rTool.lifecycle.filter((s) => s.kind === "post_measurement_estimate"),
      { kind: "turn_settled" as const, reason: "end_turn" as const },
    ];
    // turn_opened first so open-turn classification is honest
    const rGov = applyGovernorLifecycleBatch(
      createGovernorRuntimeState({ captureHealthy: true, captureGeneration: 1, descriptorReady: true }),
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
