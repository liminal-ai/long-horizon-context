import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawn } from "@lydell/node-pty";
import { inspect } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatReceiptLine, TURN_OPEN_REFUSAL } from "../../src/commands/context.js";
import { runCompactCommand } from "../../src/commands/compact.js";
import { run, type PtySpawn, type RunChildControl } from "../../src/wrapper/run.js";
import type { SessionSwapResult } from "../../src/wrapper/session-swap.js";
import {
  buildCommandCtx,
  FakeSwapChildControl,
  sleep,
  startCapturedSession,
  tempEnv,
  writeBasicRollout,
} from "./helpers.js";

const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-codex.mjs");
const spawnFakeCodex: PtySpawn = (file, args, options) => {
  const argv = Array.isArray(args) ? args : [args];
  return spawn(file, [FAKE_CODEX, ...argv], options);
};

const originalHome = process.env.CODEX_LHC_HOME;
const originalFakeHome = process.env.CODEX_LHC_FAKE_CODEX_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_LHC_HOME;
  else process.env.CODEX_LHC_HOME = originalHome;
  if (originalFakeHome === undefined) delete process.env.CODEX_LHC_FAKE_CODEX_HOME;
  else process.env.CODEX_LHC_FAKE_CODEX_HOME = originalFakeHome;
});

describe("runCompactCommand", () => {
  it("prints a compact receipt and invokes swap with serving tokens and op compact", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session, sdk, threadRef } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const printed: string[] = [];
    const swapCalls: Array<Record<string, unknown>> = [];
    const markOrder: string[] = [];

    const executeSessionSwap = vi.fn(async (input) => {
      swapCalls.push({
        op: input.op,
        tokensBefore: input.tokensBefore,
        tokensAfter: input.tokensAfter,
        threadRef: input.threadRef,
      });
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
        captureSession: session,
        child: swap.current(),
        confirmMode: "growth",
      } satisfies SessionSwapResult;
    });

    const ctx = buildCommandCtx(session, swap, {
      print: (line) => {
        printed.push(line);
      },
      swap: {
        child: swap,
        markSwapKill: () => {
          markOrder.push("mark");
        },
        executeSessionSwap,
      },
    });

    const beforeView = await inspect.view(threadRef);
    const result = await runCompactCommand(ctx);

    expect(result.messages[0]).toContain("compact view=");
    expect(printed.some((line) => line.startsWith(formatReceiptLine("compact view=")))).toBe(true);
    expect(markOrder).toEqual(["mark"]);
    expect(executeSessionSwap).toHaveBeenCalledOnce();
    expect(swapCalls[0]?.op).toBe("compact");
    if (beforeView.ok) {
      expect(swapCalls[0]?.tokensBefore).toBe(beforeView.value.loadCost.total);
    }
    const compactReceipt = result.messages[0] ?? "";
    const totalMatch = /total=(\d+)/.exec(compactReceipt);
    if (totalMatch?.[1] !== undefined) {
      expect(swapCalls[0]?.tokensAfter).toBe(Number.parseInt(totalMatch[1], 10));
    }
    expect(result.captureSession).toBe(session);
    await session.stop();
  });

  it("refuses compact while a turn is open", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const executeSessionSwap = vi.fn();
    const previewCompact = vi.spyOn(session.getCommandContext().sdk!.threadView, "previewCompact");

    const ctx = buildCommandCtx(session, swap, {
      isTurnOpen: () => true,
      swap: { child: swap, markSwapKill: () => {}, executeSessionSwap },
    });

    const result = await runCompactCommand(ctx);
    expect(result.messages).toEqual([TURN_OPEN_REFUSAL]);
    expect(executeSessionSwap).not.toHaveBeenCalled();
    expect(previewCompact).not.toHaveBeenCalled();
    previewCompact.mockRestore();
    await session.stop();
  });

  it("reports preview failure without swapping", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const executeSessionSwap = vi.fn();
    const sdk = session.getCommandContext().sdk!;
    const previewCompact = vi.spyOn(sdk.threadView, "previewCompact").mockResolvedValue({
      ok: false,
      error: { errorClass: "storage_error", code: "storage_failure", reason: "preview broke" },
    } as never);

    const result = await runCompactCommand(
      buildCommandCtx(session, swap, {
        swap: { child: swap, markSwapKill: () => {}, executeSessionSwap },
      }),
    );

    expect(result.messages[0]).toContain("compact preview error: preview broke");
    expect(executeSessionSwap).not.toHaveBeenCalled();
    previewCompact.mockRestore();
    await session.stop();
  });

  it("marks swap kill before executeSessionSwap is entered", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const order: string[] = [];

    const executeSessionSwap = vi.fn(async () => {
      order.push("swap");
      return {
        ok: false,
        phase: "rebuild",
        error: new Error("boom"),
        receipt: { ok: false, status: "rebuild_failed", oldSessionId: "old", messages: ["rebuild failed"] },
      } satisfies SessionSwapResult;
    });

    await runCompactCommand(
      buildCommandCtx(session, swap, {
        swap: {
          child: swap,
          markSwapKill: () => {
            order.push("mark");
          },
          executeSessionSwap,
        },
      }),
    );

    expect(order).toEqual(["mark", "swap"]);
    await session.stop();
  });

  it("honors recovery_failed exitCode from executeSessionSwap", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const executeSessionSwap = vi.fn(async () => ({
      ok: false,
      phase: "recovery",
      recovered: false,
      exitCode: 1,
      error: new Error("recovery spawn failed"),
      rebuilt: {
        sessionId: "new",
        rolloutPath: "/tmp/new.jsonl",
        lineCount: 1,
        replayedPrefixLines: 1,
      },
      receipt: {
        ok: false,
        status: "recovery_failed",
        oldSessionId: "old",
        messages: ["swap recovery failed"],
      },
    })) as typeof import("../../src/wrapper/session-swap.js").executeSessionSwap;

    const result = await runCompactCommand(
      buildCommandCtx(session, swap, {
        swap: { child: swap, markSwapKill: () => {}, executeSessionSwap },
      }),
    );

    expect(result.wrapperExitCode).toBe(1);
    expect(result.messages.some((line) => line.includes("swap recovery failed"))).toBe(true);
    await session.stop();
  });

  it("routes recovery_failed after dismissal through onSwapFailureAfterDismiss with terminalExit", async () => {
    const { codexHome } = tempEnv();
    const rollout = writeBasicRollout(codexHome);
    const { session } = await startCapturedSession(codexHome, rollout);
    const swap = new FakeSwapChildControl();
    const onSwapFailureAfterDismiss = vi.fn(
      (failureReceipt: string, outcomeMessages: string[], options?: { terminalExit?: boolean }) => {
        expect(options?.terminalExit).toBe(true);
        return {
          confirmed: false,
          dismissedForRespawn: true,
          failureSettled: true,
          exitReport: [...outcomeMessages, failureReceipt],
        };
      },
    );
    const executeSessionSwap = vi.fn(async (input: { onBeforeRespawn?: () => void }) => {
      input.onBeforeRespawn?.();
      return {
        ok: false,
        phase: "recovery",
        recovered: false,
        exitCode: 1,
        error: new Error("recovery spawn failed"),
        rebuilt: {
          sessionId: "new",
          rolloutPath: "/tmp/new.jsonl",
          lineCount: 1,
          replayedPrefixLines: 1,
        },
        receipt: {
          ok: false,
          status: "recovery_failed",
          oldSessionId: "old",
          messages: ["swap recovery failed"],
        },
      };
    }) as typeof import("../../src/wrapper/session-swap.js").executeSessionSwap;

    const result = await runCompactCommand(
      buildCommandCtx(session, swap, {
        swap: {
          child: swap,
          markSwapKill: () => {},
          executeSessionSwap,
          onSwapFailureAfterDismiss,
        },
      }),
    );

    expect(onSwapFailureAfterDismiss).toHaveBeenCalledOnce();
    expect(result.wrapperExitCode).toBe(1);
    expect(result.swapSettle?.exitReport).toEqual(
      expect.arrayContaining(["swap recovery failed"]),
    );
    await session.stop();
  });

  it("keeps the wrapper alive when the old child exits during swap", async () => {
    tempEnv();
    process.env.CODEX_LHC_FAKE_MODE = "sleep";
    process.env.CODEX_LHC_FAKE_SLEEP_MS = "120000";

    const stdout = { columns: 80, rows: 24, isTTY: true, write: () => true } as unknown as NodeJS.WriteStream;
    const stderr = { write: () => true } as unknown as NodeJS.WriteStream;
    const stdin = { isTTY: true, setRawMode: () => {}, on: () => {}, removeListener: () => {} } as unknown as NodeJS.ReadStream;

    let control: RunChildControl | undefined;
    const runPromise = run([], {
      codexBin: process.execPath,
      spawnPty: spawnFakeCodex,
      stdin,
      stdout,
      stderr,
      noCapture: true,
      onChildControl: (childControl) => {
        control = childControl;
      },
    });

    await sleep(60);
    expect(control).toBeDefined();
    const oldChild = control!.getCurrent();
    control!.markSwapKill(oldChild);
    oldChild.kill("SIGTERM");
    process.env.CODEX_LHC_FAKE_MODE = "rollout";
    process.env.CODEX_LHC_FAKE_EXIT_CODE = "7";
    control!.spawnReplacement([]);

    const exitCode = await runPromise;
    expect(exitCode).toBe(7);
  });
});
