import { describe, expect, it } from "vitest";

import {
  assembleMaximumShapeEnvelope,
  assembleMaxServedShape,
  assembleMaxUnservedShape,
  assembleMixedShape,
  CERTIFIED_STDOUT_CEILING_BYTES,
  MAX_TOKEN_DIGITS,
  maxWidthNonTerminalSlice,
  planByteBudget,
  proveEnvelopeFits,
} from "../../src/retrieval/budget.js";
import { sliceFooter } from "../../src/retrieval/format.js";
import { maxId } from "../../src/retrieval/budget.js";

const TOK = Number.MAX_SAFE_INTEGER;

describe("analytic envelope bound (reachable max)", () => {
  it("body-consuming partial uses max-width Next-slice footer (not from=0/remain=1)", () => {
    const plan = planByteBudget("get-turns", 4);
    expect(plan.sdkByteBudget).not.toBeNull();
    const served = assembleMaxServedShape("get-turns", 4, plan.sdkByteBudget!);
    const id0 = maxId("get-turns", 0);
    const maxSlice = maxWidthNonTerminalSlice();
    // All numeric fields carry MAX_SAFE_INTEGER digit width
    expect(String(maxSlice.fromToken).length).toBe(MAX_TOKEN_DIGITS);
    expect(String(maxSlice.toToken).length).toBe(MAX_TOKEN_DIGITS);
    expect(String(maxSlice.totalTokens).length).toBe(MAX_TOKEN_DIGITS);
    expect(maxSlice.toToken).toBe(maxSlice.fromToken + 1);
    const remain = maxSlice.totalTokens - maxSlice.toToken;
    expect(remain).toBeGreaterThan(1);
    expect(String(remain).length).toBe(MAX_TOKEN_DIGITS);

    // Exact formatter bytes — not a hand-built shorter proxy
    const longFooter = sliceFooter("get-turns", id0, maxSlice);
    expect(longFooter).toMatch(/Next slice:/);
    expect(longFooter).toContain(`--from ${maxSlice.toToken}`);
    expect(longFooter).toContain(`${remain} tok remain`);
    // Mutation of one-digit from=0/remain=1 must NOT match the proof footer
    const shortProxy = sliceFooter("get-turns", id0, {
      fromToken: 0,
      toToken: TOK - 1,
      totalTokens: TOK,
    });
    expect(shortProxy).not.toBe(longFooter);
    expect(Buffer.byteLength(longFooter, "utf8")).toBeGreaterThan(
      Buffer.byteLength(shortProxy, "utf8"),
    );
    expect(served.envelope).toContain(longFooter);
    expect(served.envelope).not.toContain(shortProxy);

    const endFooter = sliceFooter("get-turns", id0, {
      fromToken: 0,
      toToken: TOK,
      totalTokens: TOK,
    });
    expect(endFooter).toMatch(/end of content/);
    expect(served.envelope).not.toContain(endFooter);

    const id1 = maxId("get-turns", 1);
    const emptyEnd = sliceFooter("get-turns", id1, {
      fromToken: TOK,
      toToken: TOK,
      totalTokens: TOK,
    });
    expect(emptyEnd).toMatch(/nothing at token offset/);
    expect(served.envelope).toContain(emptyEnd);
  });

  it("all-served empty-ends shape is modeled and compared", () => {
    const plan = planByteBudget("get-messages", 32);
    expect(plan.sdkByteBudget).not.toBeNull();
    const served = assembleMaxServedShape("get-messages", 32, plan.sdkByteBudget!);
    const unserved = assembleMaxUnservedShape("get-messages", 32);
    const mixed = assembleMixedShape("get-messages", 32, plan.sdkByteBudget!);
    // Reviewer gap: served empty-ends can exceed mixed/unserved — must still fit
    expect(served.bytes).toBeGreaterThan(0);
    expect(Math.max(served.bytes, unserved.bytes, mixed.bytes)).toBeLessThanOrEqual(
      plan.stdoutCeiling,
    );
    // Exact structural byte equality vs re-assembly
    const again = assembleMaxServedShape("get-messages", 32, plan.sdkByteBudget!);
    expect(again.envelope).toBe(served.envelope);
    expect(again.bytes).toBe(served.bytes);
  });

  it("positive sdkByteBudget ⇒ max of all shapes fits for 1..32 both ops certified+tiny", () => {
    for (const op of ["get-turns", "get-messages"] as const) {
      for (let n = 1; n <= 32; n += 1) {
        expect(proveEnvelopeFits(op, n)).toBe(true);
        expect(proveEnvelopeFits(op, n, 12_000)).toBe(true);
        const tiny = planByteBudget(op, n, 2_000);
        if (tiny.sdkByteBudget !== null) {
          expect(proveEnvelopeFits(op, n, 2_000)).toBe(true);
        }
        // Exact structural: maximum assembler is pure of inputs
        if (tiny.sdkByteBudget !== null) {
          const a = assembleMaximumShapeEnvelope(op, n, tiny.sdkByteBudget);
          const b = assembleMaximumShapeEnvelope(op, n, tiny.sdkByteBudget);
          expect(a.envelope).toBe(b.envelope);
          expect(a.bytes).toBe(b.bytes);
          expect(a.bytes).toBeLessThanOrEqual(tiny.stdoutCeiling);
        }
        const cert = planByteBudget(op, n);
        if (cert.sdkByteBudget !== null) {
          const m = assembleMaximumShapeEnvelope(op, n, cert.sdkByteBudget);
          expect(m.bytes).toBeLessThanOrEqual(CERTIFIED_STDOUT_CEILING_BYTES);
        }
      }
    }
  });

  it("full body 32-message max shape under certified ceiling", () => {
    const plan = planByteBudget("get-messages", 32);
    const { bytes, shape, envelope } = assembleMaximumShapeEnvelope(
      "get-messages",
      32,
      plan.sdkByteBudget!,
    );
    expect(bytes).toBeLessThanOrEqual(CERTIFIED_STDOUT_CEILING_BYTES);
    expect(bytes).toBeLessThanOrEqual(plan.stdoutCeiling);
    expect(["all-served-empty-ends", "all-unserved", "mixed"]).toContain(shape);
    expect(Buffer.byteLength(envelope, "utf8") + 1).toBe(bytes);
  });
});
