import { describe, expect, it } from "vitest";

import {
  applyCaptureDegraded,
  boundDegradationReason,
  canMutateCapture,
  createCaptureGeneration,
  isCaptureHealthy,
  MAX_DEGRADATION_REASONS,
  markCaptureClosed,
  markCaptureDegraded,
  markCaptureReady,
  REASONS_CAPPED_KEY,
} from "../../src/observation/degradation.js";

describe("capture degradation", () => {
  it("starts binding — not healthy for mutation", () => {
    const state = createCaptureGeneration(1);
    expect(state.phase).toBe("binding");
    expect(isCaptureHealthy(state)).toBe(false);
    expect(canMutateCapture(state)).toBe(false);
  });

  it("latches sticky degradation within a generation", () => {
    let state = createCaptureGeneration(1);
    state = markCaptureReady(state, 0);
    expect(canMutateCapture(state)).toBe(true);
    state = markCaptureDegraded(state, "parse_error:boom");
    expect(state.phase).toBe("degraded");
    expect(state.generation).toBe(1);
    state = markCaptureDegraded(state, "intake_error:x");
    expect(state.reasons).toEqual(["parse_error", "intake_error"]);
    expect(canMutateCapture(state)).toBe(false);
  });

  it("does not expose a proof-shaped re-arm path", () => {
    let state = createCaptureGeneration(1);
    state = markCaptureReady(state, 5);
    state = markCaptureDegraded(state, "session_mismatch:other");
    expect(canMutateCapture(state)).toBe(false);
    const restarted = createCaptureGeneration(2);
    expect(restarted.phase).toBe("binding");
  });

  it("closed is terminal — degrade after close is a no-op", () => {
    let state = createCaptureGeneration(1);
    state = markCaptureReady(state, 1);
    state = markCaptureClosed(state);
    state = markCaptureDegraded(state, "parse_error:late");
    expect(state.phase).toBe("closed");
  });

  it("bounds unknown_shape reasons and caps cardinality", () => {
    expect(boundDegradationReason("unknown_shape:line_12")).toBe("unknown_shape:untyped");
    expect(boundDegradationReason("unknown_shape:type=foo")).toBe("unknown_shape:type=foo");
    let state = createCaptureGeneration(1);
    for (let i = 0; i < MAX_DEGRADATION_REASONS + 5; i += 1) {
      state = markCaptureDegraded(state, `unique_reason_${i}`);
    }
    expect(state.reasons.length).toBeLessThanOrEqual(MAX_DEGRADATION_REASONS + 1);
    expect(state.reasons).toContain("reasons_capped");
    state = markCaptureDegraded(state, "unique_reason_0");
    expect(state.reasonCounts["unique_reason_0"]).toBeGreaterThan(1);
  });

  it("caps reasonCounts under overflow; thousands of distinct unknowns stay bounded", () => {
    let state = createCaptureGeneration(1);
    // Establish a concrete normalized key before overflow so its count stays tracked.
    for (let i = 0; i < 40; i += 1) {
      state = markCaptureDegraded(state, `parse_error:line ${i} boom`);
    }
    expect(state.reasonCounts["parse_error"]).toBe(40);
    expect(Object.keys(state.reasonCounts).filter((k) => k.startsWith("parse_error")).length).toBe(1);

    for (let i = 0; i < 2_500; i += 1) {
      state = markCaptureDegraded(state, `unknown_shape:type=novel_${i}`);
    }
    expect(state.reasons.length).toBeLessThanOrEqual(MAX_DEGRADATION_REASONS + 1);
    expect(Object.keys(state.reasonCounts).length).toBeLessThanOrEqual(MAX_DEGRADATION_REASONS + 1);
    expect(state.reasons).toContain("reasons_capped");
    expect(state.reasonCounts["reasons_capped"]).toBeGreaterThan(1);
    // parse_error remains first-class and bounded even after mass overflow.
    expect(state.reasonCounts["parse_error"]).toBe(40);
  });

  it("applyCaptureDegraded reports first-only for keys and single reasons_capped transition", () => {
    let state = createCaptureGeneration(1);
    const firsts: string[] = [];
    for (let i = 0; i < MAX_DEGRADATION_REASONS + 20; i += 1) {
      const applied = applyCaptureDegraded(state, `unique_reason_${i}`);
      state = applied.state;
      if (applied.isFirstForKey) firsts.push(applied.countKey);
    }
    // At most MAX distinct + one reasons_capped first-transition.
    expect(firsts.length).toBeLessThanOrEqual(MAX_DEGRADATION_REASONS + 1);
    expect(firsts.filter((k) => k === REASONS_CAPPED_KEY)).toHaveLength(1);
    // Further overflow is not first.
    const more = applyCaptureDegraded(state, "another_novel_after_cap");
    expect(more.isFirstForKey).toBe(false);
    expect(more.countKey).toBe(REASONS_CAPPED_KEY);
    // Identical host failures: only first is first.
    let s2 = createCaptureGeneration(2);
    const a = applyCaptureDegraded(s2, "parse_error:one");
    s2 = a.state;
    const b = applyCaptureDegraded(s2, "parse_error:two");
    expect(a.isFirstForKey).toBe(true);
    expect(b.isFirstForKey).toBe(false);
    expect(b.state.reasonCounts["parse_error"]).toBe(2);
  });
});
