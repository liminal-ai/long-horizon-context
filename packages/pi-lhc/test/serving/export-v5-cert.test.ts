import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, threads } from "lhc";
import { afterEach, describe, expect, it } from "vitest";
import { capture } from "../../src/capture/converter.js";
import { mapMessage } from "../../src/capture/map-message.js";
import { TurnAccumulator } from "../../src/capture/turn-accumulator.js";
import {
  llmRequestContextMessagesToExportEntries,
  piSessionEntriesToExportEntries,
  serializeExportEntries,
} from "../../src/serving/export-serializer.js";
import { makeAssistantMessage, makeUserMessage, zeroUsage } from "../fixtures/synthetic.js";

// Cert pin: providerUsage is a messages column, not an export block — so
// enriched intake must not change threadview/PI-session export bytes.
describe("export cert byte-diff (v5 host facts)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("export cert byte-diff: usage on intake does not change export bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lhc-export-cert-"));
    dirs.push(dir);
    const registryPath = join(dir, "registry.sqlite");
    const threadPath = join(dir, "thread.sqlite");

    const sdk = initLhc({
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
      mode: "manual",
    });
    const created = await threads.newThread({ filePath: threadPath, registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const instance = {
      sdk,
      threadRef: { filePath: threadPath },
      dispose: async () => ({ ok: true as const, value: undefined }),
    };

    const user = makeUserMessage("export cert prompt", 1_700_000_000_000);
    const assistant = makeAssistantMessage({
      text: "export cert answer",
      usage: zeroUsage({ input: 42, output: 7, totalTokens: 49 }),
      stopReason: "stop",
      timestamp: 1_700_000_000_100,
    });
    const acc = new TurnAccumulator({ piSessionId: "export-cert" });
    const userEvents = mapMessage(user, { piSessionId: "export-cert", entryId: "e0" });
    acc.onMessage(userEvents, user);
    const asstEvents = mapMessage(assistant, { piSessionId: "export-cert", entryId: "e1" });
    acc.onMessage(asstEvents, assistant);
    const turnEnd = acc.onAgentEnd({ messages: [user, assistant] });
    const recorded = await capture([...userEvents, ...asstEvents, ...turnEnd], instance);
    expect(recorded.ok).toBe(true);
    expect(asstEvents[0]!.payload).toHaveProperty("providerUsage");
    expect(turnEnd[0]!.payload).toMatchObject({ outcome: "completed" });

    const ctx = await sdk.threadView.getLlmRequestContext({ filePath: threadPath });
    expect(ctx.ok).toBe(true);
    if (!ctx.ok) return;
    const threadviewBytes = serializeExportEntries(llmRequestContextMessagesToExportEntries(ctx.value.messages));

    const piEntries = [
      { type: "message" as const, id: "e0", parentId: null, message: user },
      { type: "message" as const, id: "e1", parentId: "e0", message: assistant },
    ];
    const piBytes = serializeExportEntries(piSessionEntriesToExportEntries(piEntries));

    // Cross-source parity on same conversation content.
    expect(threadviewBytes).toBe(piBytes);

    // Enriched vs bare assistant: export is role+text only — byte-identical.
    const bareAsst = makeAssistantMessage({ text: "export cert answer", timestamp: 1_700_000_000_100 });
    const barePiBytes = serializeExportEntries(
      piSessionEntriesToExportEntries([
        { type: "message", id: "e0", parentId: null, message: user },
        { type: "message", id: "e1", parentId: "e0", message: bareAsst },
      ]),
    );
    expect(barePiBytes).toBe(piBytes);
  });
});
