import { resolveTokenFamily, TokenEstimator } from "lhc";
import { describe, expect, it } from "vitest";

import { formatDurableReceipt } from "../../src/commands/context-mutation.js";
import { launchModelFlag } from "../../src/intake/launch-session.js";
import {
  pendingPromptEstimate,
  pendingPromptEstimateSource,
  userPromptEstimateSource,
} from "../../src/observation/estimate.js";
import { observeRolloutLine } from "../../src/observation/observe.js";
import {
  createSessionTokenFamilyState,
  defaultSessionTokenFamily,
  familyFromAssistantModel,
  formatTokenFamilyChangeLog,
  formatTokenFamilyLabel,
  lastAssistantModelIdFromRecords,
  noteAssistantModel,
  seedTokenFamilyAtLaunch,
} from "../../src/observation/token-family.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

describe("session token family from captured assistant model", () => {
  it("resolves claude-opus-4-6 to claude-2025 from the model id", () => {
    const resolved = familyFromAssistantModel("claude-opus-4-6");
    expect(resolved).toEqual({ family: "claude-2025", source: "model" });
    expect(resolveTokenFamily("claude-opus-4-6", "anthropic")).toEqual(resolved);
  });

  it("resolves claude-fable-5-1 to claude-2026 from the model id", () => {
    expect(familyFromAssistantModel("claude-fable-5-1")).toEqual({ family: "claude-2026", source: "model" });
  });

  it("unknown claude id falls back to claude-2026 with source provider-fallback", () => {
    const resolved = familyFromAssistantModel("claude");
    expect(resolved).toEqual({ family: "claude-2026", source: "provider-fallback" });
  });

  it("before the first assistant message the family is the provider fallback", () => {
    const state = createSessionTokenFamilyState();
    expect(state.modelId).toBeNull();
    expect(state.resolved).toEqual({ family: "claude-2026", source: "provider-fallback" });
    expect(defaultSessionTokenFamily()).toEqual(state.resolved);
  });

  it("seeds claude-2025 from launch --model before initLhc", () => {
    const argv = ["--model", "claude-opus-4-6", "--session-id", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
    const launchModel = launchModelFlag(argv);
    expect(launchModel).toBe("claude-opus-4-6");
    expect(launchModelFlag(["--model=claude-opus-4-6"])).toBe("claude-opus-4-6");
    const state = seedTokenFamilyAtLaunch({
      ...(launchModel === undefined ? {} : { launchModel }),
      resumedAssistantModel: "claude-fable-5-1",
    });
    expect(state.resolved).toEqual({ family: "claude-2025", source: "model" });
    expect(state.seedSource).toBe("launch --model");
    expect(state.modelId).toBe("claude-opus-4-6");
    expect(state.estimator.family).toBe("claude-2025");
    expect(formatTokenFamilyLabel(state)).toBe("claude-2025 (launch --model)");
  });

  it("seeds from the last recorded assistant model on resume", () => {
    const modelId = lastAssistantModelIdFromRecords([
      { kind: "user_prompt", blocks: [{ content: { text: "hi" } }] },
      { kind: "assistant_text", blocks: [{ content: { text: "first", model: "claude-opus-4-6" } }] },
      { kind: "assistant_thinking", blocks: [{ content: { text: "later", model: "claude-sonnet-4-6" } }] },
    ]);
    expect(modelId).toBe("claude-sonnet-4-6");
    const state = seedTokenFamilyAtLaunch({ resumedAssistantModel: modelId });
    expect(state.resolved).toEqual({ family: "claude-2025", source: "model" });
    expect(state.seedSource).toBe("resumed record");
    expect(state.modelId).toBe("claude-sonnet-4-6");
    expect(formatTokenFamilyLabel(state)).toBe("claude-2025 (resumed record)");
  });

  it("seeds the provider fallback when launch has no --model and no resume record", () => {
    const state = seedTokenFamilyAtLaunch({});
    expect(launchModelFlag(["--verbose", "--session-id", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"])).toBeUndefined();
    expect(
      lastAssistantModelIdFromRecords([{ kind: "user_prompt", blocks: [{ content: { text: "hi" } }] }]),
    ).toBeNull();
    expect(state.modelId).toBeNull();
    expect(state.resolved).toEqual({ family: "claude-2026", source: "provider-fallback" });
    expect(state.seedSource).toBe("provider fallback");
    expect(formatTokenFamilyLabel(state)).toBe("claude-2026 (provider fallback)");
  });

  it("ignores Claude Code's synthetic model id for re-resolution and record seeding", () => {
    const state = createSessionTokenFamilyState({ modelId: "claude-opus-4-6", seedSource: "launch --model" });
    expect(noteAssistantModel(state, "<synthetic>")).toBe(false);
    expect(state.resolved.family).toBe("claude-2025");
    expect(
      lastAssistantModelIdFromRecords([
        { kind: "assistant_text", blocks: [{ content: { model: "claude-opus-4-6" } }] },
        { kind: "assistant_text", blocks: [{ content: { model: "<synthetic>" } }] },
      ]),
    ).toBe("claude-opus-4-6");
  });

  it("re-resolves on a model change and reports it as one log line", () => {
    const state = createSessionTokenFamilyState();
    expect(noteAssistantModel(state, "claude-opus-4-6")).toBe(true);
    expect(state.resolved).toEqual({ family: "claude-2025", source: "model" });
    expect(state.estimator.family).toBe("claude-2025");
    const previous = state.resolved;
    expect(noteAssistantModel(state, "claude-fable-5-1")).toBe(true);
    expect(state.resolved).toEqual({ family: "claude-2026", source: "model" });
    expect(formatTokenFamilyChangeLog(previous, state.resolved, "claude-fable-5-1")).toBe(
      "cc-lhc token family: claude-2025 (model) -> claude-2026 (model) model=claude-fable-5-1",
    );
    expect(noteAssistantModel(state, "claude-fable-5-1")).toBe(false);
  });

  it("estimate-source labels include the family slug", () => {
    expect(userPromptEstimateSource("claude-2025")).toBe("user_prompt:js-tiktoken:o200k_base:claude-2025");
    expect(pendingPromptEstimateSource("claude-2026")).toBe("pending_prompt:js-tiktoken:o200k_base:claude-2026");
    const opus = new TokenEstimator("claude-2025");
    expect(pendingPromptEstimate("hi", opus).source).toBe("pending_prompt:js-tiktoken:o200k_base:claude-2025");
  });

  it("observeRolloutLine resolves the family from a captured assistant message.model", () => {
    const state = createSessionTokenFamilyState();
    const item = {
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hello" }],
      },
    } as RolloutLineItem;
    observeRolloutLine(item, 0, { tokenFamily: state });
    expect(state.modelId).toBe("claude-opus-4-6");
    expect(state.resolved).toEqual({ family: "claude-2025", source: "model" });
  });

  it("compact runtime note appends the family", () => {
    expect(
      formatDurableReceipt("auto_compact", {
        origin: "auto",
        triggerContextTokens: 508_000,
        viewTokens: 247_000,
        targetTokens: 240_000,
        tokenFamily: "claude-2026",
        tokenFamilySeedSource: "provider fallback",
      }),
    ).toBe(
      "[lhc compact:auto] trigger context 508k; rebuilt LHC view 247k (240k target); family claude-2026 (provider fallback).",
    );
  });
});
