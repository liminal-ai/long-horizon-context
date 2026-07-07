import { spawn as defaultSpawn, type IPty } from "@lydell/node-pty";

import {
  dispatchLhcCommand,
  formatCommandOutput,
  type LhcCommandRuntime,
  type SessionRestartPlan,
} from "../commands/dispatch.js";
import { killAllInferenceChildren } from "../inference/claude-cli.js";
import { hasContinueFlag, parseResumeSessionId } from "../intake/argv.js";
import { defaultLineageDbPath, safeRecordSessionThread } from "../intake/lineage-db.js";
import { type CaptureSession, startCaptureSession } from "../intake/session.js";
import { emptyCaptureStats, formatCaptureStatsLine } from "../stats.js";
import { COMMAND_BUSY_MESSAGE, CommandInFlightGuard } from "./command-guard.js";
import { createInputDebugLogger } from "./input-debug.js";
import {
  createInputState,
  finishExecuting,
  forceResetInput,
  type InputState,
  processInputChunk,
  resolveBareEsc,
  resolveLeaderByte,
  showReceipts,
} from "./modal.js";
import { OutputHold } from "./output-hold.js";
import { executeResumeInjection, formatResumeAbortTurnOpen, formatResumeFailure } from "./resume-injection.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM_NAME = "xterm-256color";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * Cap on pty output held while the modal is open. Claude keeps running while
 * we hold its bytes; a runaway stream must not grow unbounded, so past the
 * cap the modal is cancelled, a one-line notice printed, and everything
 * flushed.
 */
export const OUTPUT_HOLD_CAP_BYTES = 4 * 1024 * 1024;
export const OUTPUT_HOLD_OVERFLOW_MESSAGE = "output buffer full — command entry cancelled";
/**
 * How long a pending ESC may sit unresolved before it is ruled a bare Esc
 * keypress. Split escape sequences deliver their next byte within a few ms;
 * kitty-protocol terminals never send a bare ESC at all.
 */
export const PENDING_ESC_RESOLVE_MS = 50;

export type PtySpawn = typeof defaultSpawn;

export type RunOptions = {
  claudeBin?: string;
  spawnPty?: PtySpawn;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  noCapture?: boolean;
  noInference?: boolean;
};

import { resolveClaudeBin } from "../shared/claude-bin.js";

export { resolveClaudeBin };

export function resizePty(pty: Pick<IPty, "resize">, cols: number, rows: number): void {
  pty.resize(cols, rows);
}

export function onTerminalResize(
  pty: Pick<IPty, "resize">,
  stdout: Pick<NodeJS.WriteStream, "columns" | "rows">,
): void {
  resizePty(pty, stdout.columns ?? DEFAULT_COLS, stdout.rows ?? DEFAULT_ROWS);
}

function restoreTerminal(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): void {
  if (stdin.isTTY) {
    stdin.setRawMode(false);
  }
  if (stdout.isTTY) {
    stdout.write(SHOW_CURSOR);
  }
}

export function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const claudeBin = options.claudeBin ?? resolveClaudeBin();
  const spawnPty = options.spawnPty ?? defaultSpawn;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const noCapture = options.noCapture === true;
  const noInference = options.noInference === true || process.env.CC_LHC_NO_INFERENCE === "1";
  const resumeSessionId = parseResumeSessionId(argv);
  const continueFlag = hasContinueFlag(argv);
  const commandGuard = new CommandInFlightGuard();

  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;

  const ptyProcess = spawnPty(claudeBin, argv, {
    name: TERM_NAME,
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  let exited = false;
  let captureSession: CaptureSession | undefined;
  const startedAt = new Date();

  const printStats = (): void => {
    if (captureSession === undefined) return;
    stderr.write(`${formatCaptureStatsLine(captureSession.stats)}\n`);
  };

  const onSigusr1 = (): void => {
    printStats();
  };

  if (!noCapture) {
    captureSession = startCaptureSession({
      startedAt,
      noInference,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(continueFlag ? { continueFlag: true } : {}),
      lineageDbPath: defaultLineageDbPath(),
    });
    process.on("SIGUSR1", onSigusr1);
  }

  const cleanup = (): void => {
    restoreTerminal(stdin, stdout);
    process.removeListener("SIGUSR1", onSigusr1);
  };

  process.on("exit", cleanup);

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }

  // The resume tripwire taps forwarded output for the duration of its watch
  // window; it must keep seeing data even while the modal holds output.
  let outputTap: ((data: string) => void) | null = null;

  const leaderByte = resolveLeaderByte(process.env.CC_LHC_LEADER, (message) => {
    stderr.write(`${message}\n`);
  });
  let inputState: InputState = createInputState(leaderByte);

  // While the modal (or an executing command) owns the screen, pty output is
  // held — claude keeps running; we just delay rendering its bytes.
  const outputHold = new OutputHold(
    OUTPUT_HOLD_CAP_BYTES,
    (data) => stdout.write(data),
    () => {
      const reset = forceResetInput(inputState);
      inputState = reset.state;
      if (reset.toStdout !== "") stdout.write(reset.toStdout);
      stdout.write(formatCommandOutput(OUTPUT_HOLD_OVERFLOW_MESSAGE));
      stdout.write("\r\n");
      outputHold.flush();
    },
  );

  const forwardOutput = (data: string): void => {
    outputHold.feed(data);
    outputTap?.(data);
  };

  const commandRuntime = (): LhcCommandRuntime => {
    const rollout = captureSession?.getRolloutInfo();
    if (noCapture || captureSession === undefined) {
      return {
        captureDisabled: true,
        stats: emptyCaptureStats(),
        sdk: undefined,
        threadRef: undefined,
        cwd: process.cwd(),
        sourceRolloutPath: undefined,
        sourceSessionId: undefined,
      };
    }
    const ctx = captureSession.getCommandContext();
    return {
      ...ctx,
      cwd: process.cwd(),
      sourceRolloutPath: rollout?.path,
      sourceSessionId: rollout?.sessionId,
      isTurnOpen: () => captureSession?.isTurnOpen() ?? false,
    };
  };

  const handleSigwinch = (): void => {
    onTerminalResize(ptyProcess, stdout);
  };
  process.on("SIGWINCH", handleSigwinch);

  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (!exited) {
      ptyProcess.kill(signal);
    }
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  return new Promise((resolve) => {
    const teardownAndExit = async (exitCode: number): Promise<void> => {
      if (exited) return;
      exited = true;
      if (pendingEscTimer !== null) {
        clearTimeout(pendingEscTimer);
        pendingEscTimer = null;
      }
      stdin.removeListener("data", forwardInput);
      process.removeListener("SIGWINCH", handleSigwinch);
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      outputHold.flush();
      if (captureSession !== undefined) {
        await captureSession.stop().catch(() => {});
        printStats();
        killAllInferenceChildren();
      }
      cleanup();
      resolve(exitCode);
    };

    /** Runs the injection; returns receipt lines to print (empty on success). */
    const performResumeInjection = async (plan: SessionRestartPlan): Promise<string[]> => {
      if (noCapture || captureSession === undefined) return [];
      const result = await executeResumeInjection({
        plan,
        captureSession,
        writeToPty: (data) => {
          ptyProcess.write(data);
        },
        onOutput: (listener) => {
          outputTap = listener;
          return () => {
            outputTap = null;
          };
        },
        startCapture: (injectedAt, continueCapture, rolloutPath) =>
          startCaptureSession({
            startedAt: injectedAt,
            noInference,
            continueCapture,
            lineageDbPath: defaultLineageDbPath(),
            knownRolloutPath: rolloutPath,
            replayedPrefixLines: plan.replayedPrefixLines,
          }),
        recordLineage: async ({ sessionId, threadId }) => {
          await safeRecordSessionThread(defaultLineageDbPath(), sessionId, threadId, (message) => {
            stderr.write(`${message}\n`);
          });
        },
        isTurnOpen: () => captureSession?.isTurnOpen() ?? false,
        logResume: (message) => {
          stderr.write(`${message}\n`);
        },
      });
      if (result.ok) {
        // No raw success print: the receipt is a trailing runtime-note line in
        // the rebuilt rollout (rendered natively in the transcript), and the
        // injected repaint nudge would wipe anything written here anyway.
        captureSession = result.captureSession;
        return [];
      }
      return [result.reason === "turn_open" ? formatResumeAbortTurnOpen(plan) : formatResumeFailure(plan)];
    };

    const debugInput = createInputDebugLogger(process.env.CC_LHC_INPUT_DEBUG);

    // A modal-executed command settles here. Receipts render as modal rows
    // above a fresh prompt, screen still held — the only rendering that
    // survives a running turn (rig-verified: raw prints, before OR after the
    // flush, are overwritten by the TUI's next repaint within a frame). The
    // user reads the receipt, then dismisses the modal (Esc/ctrl-C/leader),
    // which erases our rows and flushes the held output.
    const settleCommand = (messages: string[]): void => {
      if (inputState.mode !== "executing") {
        // Modal was force-cancelled (held-output overflow) while the command
        // ran: the screen is live again, so print raw — visibility is
        // best-effort in this degenerate case.
        for (const message of messages) stdout.write(formatCommandOutput(message));
        if (messages.length > 0) stdout.write("\r\n");
        return;
      }
      if (messages.length === 0) {
        const finished = finishExecuting(inputState);
        inputState = finished.state;
        if (finished.toStdout !== "") stdout.write(finished.toStdout);
        outputHold.flush();
        return;
      }
      const shown = showReceipts(inputState, messages);
      inputState = shown.state;
      stdout.write(shown.toStdout);
    };

    const runModalCommand = (commandLine: string): void => {
      if (!commandGuard.tryAcquire()) {
        settleCommand([COMMAND_BUSY_MESSAGE]);
        return;
      }
      void dispatchLhcCommand(commandLine, commandRuntime())
        .then(async (outcome) => {
          const messages = [...outcome.messages];
          if (outcome.restart !== undefined) {
            messages.push(...(await performResumeInjection(outcome.restart)));
          }
          settleCommand(messages);
        })
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          settleCommand([`command error: ${message}`]);
        })
        .finally(() => {
          commandGuard.release();
        });
    };

    const applyActions = (actions: ReturnType<typeof processInputChunk>["actions"]): void => {
      for (const action of actions) {
        if (action.kind === "enter_modal") outputHold.hold();
        else if (action.kind === "exit_modal") outputHold.flush();
        else if (action.kind === "execute") runModalCommand(action.commandLine);
      }
    };

    // A pending ESC held by the modal is resolved by the next byte; when no
    // byte follows (a truly bare Esc keypress), this timer rules it bare so
    // the cancel is never ambiguous for longer than PENDING_ESC_RESOLVE_MS.
    let pendingEscTimer: NodeJS.Timeout | null = null;

    const armPendingEscTimer = (): void => {
      if (pendingEscTimer !== null) {
        clearTimeout(pendingEscTimer);
        pendingEscTimer = null;
      }
      if (inputState.mode === "passthrough" || inputState.escape?.kind !== "pending_esc") return;
      pendingEscTimer = setTimeout(() => {
        pendingEscTimer = null;
        const resolved = resolveBareEsc(inputState);
        if (resolved === null) return;
        inputState = resolved.state;
        if (resolved.toStdout !== "") stdout.write(resolved.toStdout);
        applyActions(resolved.actions);
      }, PENDING_ESC_RESOLVE_MS);
      pendingEscTimer.unref?.();
    };

    const forwardInput = (data: Buffer): void => {
      const result = processInputChunk(data, inputState);
      inputState = result.state;
      debugInput(data, inputState);
      if (result.toStdout !== "") stdout.write(result.toStdout);
      if (result.toPty.length > 0) ptyProcess.write(result.toPty);
      applyActions(result.actions);
      armPendingEscTimer();
    };

    const onExit = async ({ exitCode, signal }: { exitCode: number; signal?: number }): Promise<void> => {
      if (exited) return;
      await teardownAndExit(signal !== undefined && signal !== 0 ? 128 + signal : (exitCode ?? 1));
    };

    ptyProcess.onData(forwardOutput);
    ptyProcess.onExit(onExit);
    stdin.on("data", forwardInput);
  });
}
