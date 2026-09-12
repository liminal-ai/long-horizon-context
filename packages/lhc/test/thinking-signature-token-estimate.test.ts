import { describe, expect, it } from "vitest";
import type { RecordedEvent } from "../src/messages/index.js";
import { projectEvent } from "../src/messages/internal/project.js";
import { estimateSignatureTokens, estimateTokens } from "../src/shared-tech/token-counting/index.js";
import { validEvent } from "./fixtures/index.js";

function thinkingEvent(text: string, signature?: string): RecordedEvent {
  const event = validEvent("assistant_thinking", {
    payload: signature === undefined ? { text } : { text, signature },
  });
  return { ...event, eventOrder: 1, recordedAt: "2026-09-12T00:00:00.000Z" };
}

describe("estimateSignatureTokens", () => {
  it.each([
    [912, 159],
    [1_400, 244],
    [4_000, 697],
  ])("estimates a %i-char base64 signature as %i billed tokens", (length, expected) => {
    expect(estimateSignatureTokens("A".repeat(length))).toBe(expected);
  });
});

describe("assistant_thinking token projection", () => {
  it("adds signature tokens at the provider's billed rate", () => {
    const text = "considering the evidence";
    const signature = "A".repeat(1_400);

    expect(projectEvent(thinkingEvent(text, signature))?.tokenEstimate).toBe(
      estimateTokens(text) + estimateSignatureTokens(signature),
    );
  });

  it("counts text only when the signature is omitted", () => {
    const text = "considering the evidence";

    expect(projectEvent(thinkingEvent(text))?.tokenEstimate).toBe(estimateTokens(text));
  });

  it("keeps empty-signature behavior at text only", () => {
    const text = "considering the evidence";

    expect(projectEvent(thinkingEvent(text, ""))?.tokenEstimate).toBe(estimateTokens(text));
  });
});
