import { createDeterministicInferenceCallbacks, type ThreadRef } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Connector,
  clearLauncherOwnedStartup,
  createConnector,
  setLauncherOwnedStartup,
} from "../../src/index.js";
import type { CompactOptions, ContextUsage, ExtensionContext } from "../../src/pi/types.js";
import { makeAgentEnd, makeSessionStart } from "../fixtures/synthetic.js";
import { makeTempThread, type TempStore, tempStore } from "../fixtures/thread.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
  clearLauncherOwnedStartup();
});
afterEach(() => {
  store.cleanup();
  clearLauncherOwnedStartup();
});

interface AutoCompactCtx extends ExtensionContext {
  compactSpy: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: {
  tokens: number | null;
  modelId?: string;
  pending?: boolean;
  compactOutcome?: "complete" | "error" | "hang";
}): AutoCompactCtx {
  const compactSpy = vi.fn((options?: CompactOptions) => {
    if (opts.compactOutcome === "error") options?.onError?.(new Error("cancelled"));
    else if (opts.compactOutcome !== "hang") options?.onComplete?.({} as never);
  });
  return {
    cwd: "/work/auto-compact",
    hasUI: false,
    modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
    ui: { notify: () => {} },
    sessionManager: { getEntries: () => [] },
    model: { provider: "anthropic", id: opts.modelId ?? "claude-fable-5" },
    getContextUsage: (): ContextUsage => ({
      tokens: opts.tokens,
      contextWindow: 1_000_000,
      percent: opts.tokens === null ? null : opts.tokens / 10_000,
    }),
    hasPendingMessages: () => opts.pending === true,
    compact: compactSpy as unknown as (options?: CompactOptions) => void,
    compactSpy,
  };
}

async function startedConnector(): Promise<{ connector: Connector; ctx: AutoCompactCtx }> {
  const created = await makeTempThread(store);
  const ref: ThreadRef = { threadId: created.threadId, registryPath: store.registryPath };
  setLauncherOwnedStartup({ threadRef: ref, launchFlags: { thread: created.threadId } });
  const connector = createConnector({
    registryPath: store.registryPath,
    newThreadFilePath: () => store.threadPath(),
    buildSdkConfig: () => ({
      ok: true,
      value: { inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: "background" },
    }),
  });
  const ctx = makeCtx({ tokens: 400_000 });
  await connector.handlers.session_start(makeSessionStart("startup"), ctx);
  expect(connector.getState()).not.toBeNull();
  return { connector, ctx };
}

describe("per-model auto-compact trigger", () => {
  it("never fires from turn_end — ctx.compact aborts an in-flight run", async () => {
    const { connector, ctx } = await startedConnector();
    await connector.handlers.turn_end({ type: "turn_end", turnIndex: 0, message: {} as never, toolResults: [] }, ctx);
    expect(ctx.compactSpy).not.toHaveBeenCalled();
  });

  it("fires at agent_end when usage crosses the model threshold", async () => {
    const { connector, ctx } = await startedConnector();
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);
    expect(ctx.compactSpy).toHaveBeenCalledTimes(1);
  });

  it("stays quiet below threshold, with unknown usage, and for unmatched models", async () => {
    const { connector } = await startedConnector();
    for (const ctx of [
      makeCtx({ tokens: 200_000 }),
      makeCtx({ tokens: null }),
      makeCtx({ tokens: 400_000, modelId: "some-unknown-model" }),
    ]) {
      await connector.handlers.agent_end(makeAgentEnd([]), ctx);
      expect(ctx.compactSpy).not.toHaveBeenCalled();
    }
  });

  it("defers when follow-up messages are queued", async () => {
    const { connector } = await startedConnector();
    const ctx = makeCtx({ tokens: 400_000, pending: true });
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);
    expect(ctx.compactSpy).not.toHaveBeenCalled();
  });

  it("does not re-fire while a triggered compact is still in flight", async () => {
    const { connector } = await startedConnector();
    const ctx = makeCtx({ tokens: 400_000, compactOutcome: "hang" });
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);
    await connector.handlers.agent_end(makeAgentEnd([]), ctx);
    expect(ctx.compactSpy).toHaveBeenCalledTimes(1);
  });

  it("after a cancelled attempt, re-fires only once usage grows by the retry margin", async () => {
    const { connector } = await startedConnector();
    const cancelled = makeCtx({ tokens: 400_000, compactOutcome: "error" });
    await connector.handlers.agent_end(makeAgentEnd([]), cancelled);
    expect(cancelled.compactSpy).toHaveBeenCalledTimes(1);

    const sameSize = makeCtx({ tokens: 410_000 });
    await connector.handlers.agent_end(makeAgentEnd([]), sameSize);
    expect(sameSize.compactSpy).not.toHaveBeenCalled();

    const grown = makeCtx({ tokens: 430_000 });
    await connector.handlers.agent_end(makeAgentEnd([]), grown);
    expect(grown.compactSpy).toHaveBeenCalledTimes(1);
  });
});
