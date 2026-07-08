import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PRUNE_TARGET_TOKENS, formatReceiptLine, TURN_OPEN_REFUSAL } from "../../src/commands/context.js";
import { runPruneCommand } from "../../src/commands/prune.js";
import type { SessionSwapResult } from "../../src/wrapper/session-swap.js";
import {
  buildCommandCtx,
  FakeSwapChildControl,
  manualSdk,
  newPrunableThread,
  startCapturedSession,
  tempEnv,
  writeBasicRollout,
} from "./helpers.js";

const originalHome = process.env.CODEX_LHC_HOME;
const originalFakeHome = process.env.CODEX_LHC_FAKE_CODEX_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_LHC_HOME;
  else process.env.CODEX_LHC_HOME = originalHome;
  if (originalFakeHome === undefined) delete process.env.CODEX_LHC_FAKE_CODEX_HOME;
  else process.env.CODEX_LHC_FAKE_CODEX_HOME = originalFakeHome;
});

describe("runPruneCommand", () => {
  it("prints a no-op receipt without swapping when the zone is already under target", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const executeSessionSwap = vi.fn();

    const result = await runPruneCommand(
      buildCommandCtx(session, swap, {
        swap: { child: swap, markSwapKill: () => {}, executeSessionSwap },
      }),
    );

    expect(result.messages[0]).toContain("no-op");
    expect(executeSessionSwap).not.toHaveBeenCalled();
    expect(result.captureSession).toBeUndefined();
    await session.stop();
  });

  it("swaps after a boundary-moving prune with op prune", async () => {
    tempEnv();
    const sdk = manualSdk({ visibility: { maxTokens: 100, targetTokens: 60 } });
    const threadRef = await newPrunableThread(sdk);
    const swap = new FakeSwapChildControl();
    const executeSessionSwap = vi.fn(async (input) => {
      expect(input.op).toBe("prune");
      return {
        ok: true,
        receipt: {
          ok: true,
          status: "success",
          oldSessionId: "old",
          newSessionId: "new",
          rolloutPath: "/tmp/new.jsonl",
          confirmMode: "growth",
          messages: ["swap confirmed"],
        },
        rebuilt: {
          sessionId: "new",
          rolloutPath: "/tmp/new.jsonl",
          lineCount: 1,
          replayedPrefixLines: 1,
        },
        captureSession: fakeSession as never,
        child: swap.current(),
        confirmMode: "growth",
      } satisfies SessionSwapResult;
    });

    const fakeSession = {
      stats: { threadId: "threadId" in threadRef ? threadRef.threadId : null },
      getCommandContext: () => ({ captureDisabled: false, stats: fakeSession.stats, sdk, threadRef }),
      getRolloutInfo: () => ({ path: "/tmp/rollout.jsonl", sessionId: "sess" }),
      isTurnOpen: () => false,
      stop: async () => {},
    };

    const result = await runPruneCommand(
      buildCommandCtx(fakeSession as never, swap, {
        sdk,
        threadRef,
        sourceRolloutPath: "/tmp/rollout.jsonl",
        sourceSessionId: "sess",
        session: fakeSession as never,
        swap: { child: swap, markSwapKill: () => {}, executeSessionSwap },
      }),
      60,
    );

    expect(result.messages[0]).toContain("applied");
    expect(executeSessionSwap).toHaveBeenCalledOnce();
  });

  it("defaults prune target to the SDK profile when targetTokens is omitted", async () => {
    tempEnv();
    const sdk = manualSdk();
    const threadRef = await newPrunableThread(sdk);
    const prune = vi.spyOn(sdk.threadView, "prune");
    const swap = new FakeSwapChildControl();

    const fakeSession = {
      stats: { threadId: "threadId" in threadRef ? threadRef.threadId : null },
      getCommandContext: () => ({ captureDisabled: false, stats: fakeSession.stats, sdk, threadRef }),
      getRolloutInfo: () => ({ path: "/tmp/rollout.jsonl", sessionId: "sess" }),
      isTurnOpen: () => false,
      stop: async () => {},
    };

    await runPruneCommand(
      buildCommandCtx(fakeSession as never, swap, {
        sdk,
        threadRef,
        sourceRolloutPath: "/tmp/rollout.jsonl",
        session: fakeSession as never,
        swap: {
          child: swap,
          markSwapKill: () => {},
          executeSessionSwap: vi.fn(async () =>
            ({
              ok: false,
              phase: "rebuild",
              error: new Error("stop"),
              receipt: { ok: false, status: "rebuild_failed", oldSessionId: "old", messages: [] },
            }) satisfies SessionSwapResult,
          ),
        },
      }),
    );

    expect(prune).toHaveBeenCalledWith(threadRef, {});
    expect(DEFAULT_PRUNE_TARGET_TOKENS).toBe(32_000);
    prune.mockRestore();
  });

  it("refuses prune while a turn is open", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const prune = vi.spyOn(session.getCommandContext().sdk!.threadView, "prune");

    const result = await runPruneCommand(
      buildCommandCtx(session, swap, {
        isTurnOpen: () => true,
        swap: { child: swap, markSwapKill: () => {} },
      }),
    );

    expect(result.messages).toEqual([TURN_OPEN_REFUSAL]);
    expect(prune).not.toHaveBeenCalled();
    prune.mockRestore();
    await session.stop();
  });

  it("prefixes prune receipts with [codex-lhc]", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const printed: string[] = [];

    await runPruneCommand(
      buildCommandCtx(session, swap, {
        print: (line) => {
          printed.push(line);
        },
        swap: { child: swap, markSwapKill: () => {} },
      }),
    );

    expect(printed[0]?.startsWith(formatReceiptLine("prune boundary"))).toBe(true);
    await session.stop();
  });
});
