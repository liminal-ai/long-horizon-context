import { beforeEach, describe, expect, test } from "vitest";
import type { Lhc, MessageEventInput } from "../src/client/index.js";
import { type ServiceFixture, serviceFixture, validEvent } from "./fixtures/index.js";

let fixture: ServiceFixture;
let sdk: Lhc;

beforeEach(() => {
  fixture = serviceFixture();
  sdk = fixture.sdk;
});

async function send(filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`batch failed: ${result.error.reason}`);
}

describe("Story 2: tool-result rendering", () => {
  test("tool-call arguments render as recorded", async () => {
    const filePath = (await fixture.createThread()).filePath;
    await send(filePath, [
      validEvent("user_prompt", { payload: { text: "run it" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call", toolName: "exec", arguments: { cmd: "pnpm test" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "call", content: "passed", isError: false } }),
      validEvent("turn_end"),
    ]);
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    const report = await sdk.turns.report({ filePath }, { turnId: "t1" });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.find((row) => row.derivationType === "turn_rendering")?.content).toContain(
      'exec({"cmd":"pnpm test"})',
    );
  });

  test("tail tool-call rendering preserves long recorded arguments without truncation", async () => {
    const filePath = (await fixture.createThread()).filePath;
    const cmd = "x".repeat(240);
    const args = JSON.stringify({ cmd });
    await send(filePath, [
      validEvent("tool_call", {
        payload: { toolCallId: "long-call", toolName: "exec", arguments: { cmd } },
      }),
    ]);
    const contextRead = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextRead.ok).toBe(true);
    if (!contextRead.ok) return;
    const rendered = contextRead.value.messages
      .map((message) => message.content.map((part) => part.text).join(""))
      .join("\n");
    expect(rendered).toContain(`[tool call · exec] ${args}`);
    expect(rendered).not.toContain("truncated");
  });
});
