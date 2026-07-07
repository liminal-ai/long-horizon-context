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
import { createAltScreenGuard, renderPanel } from "./panel.js";
import { executeResumeInjection, formatResumeAbortTurnOpen, formatResumeFailure } from "./resume-injection.js";
import { createWrapperLog, type WrapperLog } from "./wrapper-log.js";

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

/**
 * What the panel shows when a command settles. null means AUTO-DISMISS: a
 * CONFIRMED swap already carries its receipt as a runtime note rendered
 * natively in the resumed transcript, so the panel closes itself and the
 * user watches the session repaint. Refusals, errors, no-ops, and
 * status/stats keep the stay-until-dismissed rhythm.
 */
export function settleReceipts(
  outcomeMessages: string[],
  resume: { swapped: boolean; receipts: string[] } | null,
): string[] | null {
  if (resume === null) return outcomeMessages;
  if (resume.swapped) return null;
  return [...outcomeMessages, ...resume.receipts];
}

export type PtySpawn = typeof defaultSpawn;

export type RunOptions = {
  claudeBin?: string;
  spawnPty?: PtySpawn;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  noCapture?: boolean;
  noInference?: boolean;
  /** Test hook: substitute the wrapper log (defaults to ~/.cc-lhc/wrapper.log). */
  wrapperLog?: WrapperLog;
  /** Test hook: cap held pty output while the modal is open (defaults to 4 MiB). */
  outputHoldCapBytes?: number;
  /** Test hook: shorten the resume tripwire window (defaults to 3s). */
  resumeWindowMs?: number;
  /** Test hook: shorten post-tripwire growth polling (defaults to 5s). */
  resumeConfirmExtraMs?: number;
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

  // Doctrine: the wrapper NEVER writes raw bytes into a UI it does not own.
  // While the child owns the terminal, diagnostics go to the wrapper log
  // (surface (c)); `status` reports the warning count so nothing is lost.
  const wrapperLog = options.wrapperLog ?? createWrapperLog();

  // Alt-screen truth for every exit path, normal or not: the process-exit
  // hook, signal handlers, and stdin loss all leave through this guard, so a
  // crash between ?1049h and a normal dismiss still restores the terminal,
  // and no path can double-leave.
  const altScreen = createAltScreenGuard((data) => stdout.write(data));

  // Exit stats print on stderr only from teardown, AFTER the child has
  // exited and the screen is back with the shell — legitimate surface (d).
  const printExitStats = (): void => {
    if (captureSession === undefined) return;
    stderr.write(`${formatCaptureStatsLine(captureSession.stats)}\n`);
  };

  // SIGUSR1 can fire at any moment while claude owns the screen: the stats
  // snapshot goes to the wrapper log, never the terminal.
  const onSigusr1 = (): void => {
    if (captureSession === undefined) return;
    wrapperLog.info(formatCaptureStatsLine(captureSession.stats));
  };

  if (!noCapture) {
    captureSession = startCaptureSession({
      startedAt,
      noInference,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(continueFlag ? { continueFlag: true } : {}),
      lineageDbPath: defaultLineageDbPath(),
      log: (message) => wrapperLog.info(message),
      logError: (message) => wrapperLog.warn(message),
    });
    process.on("SIGUSR1", onSigusr1);
  }

  const cleanup = (): void => {
    altScreen.leave();
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
    wrapperLog.warn(message);
  });
  let inputState: InputState = createInputState(leaderByte);

  // While the modal (or an executing command) owns the screen, pty output is
  // held — claude keeps running; we just delay rendering its bytes.
  const outputHold = new OutputHold(
    options.outputHoldCapBytes ?? OUTPUT_HOLD_CAP_BYTES,
    (data) => stdout.write(data),
    () => {
      inputState = forceResetInput(inputState);
      altScreen.leave();
      // No terminal notice — the child owns the restored screen. The event is
      // logged and counted; `status` will surface it.
      wrapperLog.warn(OUTPUT_HOLD_OVERFLOW_MESSAGE);
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
      warnings: { count: wrapperLog.warningCount(), logPath: wrapperLog.path },
    };
  };

  const renderModalPanel = (): void => {
    if (inputState.mode === "passthrough") return;
    stdout.write(renderPanel(inputState, stdout.columns ?? DEFAULT_COLS, stdout.rows ?? DEFAULT_ROWS));
  };

  const handleSigwinch = (): void => {
    onTerminalResize(ptyProcess, stdout);
    renderModalPanel();
  };
  process.on("SIGWINCH", handleSigwinch);

  // Signals restore the terminal FIRST (leave alt, flush held output —
  // ordering invariant intact), then forward to the child as before. The
  // child may ignore the signal and keep running; the wrapper must already be
  // back on the main screen either way.
  const restoreIfModal = (): void => {
    if (!altScreen.active && inputState.mode === "passthrough") return;
    inputState = forceResetInput(inputState);
    altScreen.leave();
    outputHold.flush();
  };

  const forwardSignal = (signal: NodeJS.Signals): void => {
    restoreIfModal();
    if (!exited) {
      ptyProcess.kill(signal);
    }
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  process.on("SIGHUP", forwardSignal);

  return new Promise((resolve) => {
    const teardownAndExit = async (exitCode: number): Promise<void> => {
      if (exited) return;
      exited = true;
      if (pendingEscTimer !== null) {
        clearTimeout(pendingEscTimer);
        pendingEscTimer = null;
      }
      stdin.removeListener("data", forwardInput);
      stdin.removeListener("end", onStdinGone);
      stdin.removeListener("close", onStdinGone);
      stdin.removeListener("error", onStdinError);
      process.removeListener("SIGWINCH", handleSigwinch);
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      process.removeListener("SIGHUP", forwardSignal);
      altScreen.leave();
      outputHold.flush();
      if (captureSession !== undefined) {
        await captureSession.stop().catch(() => {});
        printExitStats();
        killAllInferenceChildren();
      }
      cleanup();
      resolve(exitCode);
    };

    /** Runs the injection; swapped=true means the panel should auto-dismiss. */
    const performResumeInjection = async (
      plan: SessionRestartPlan,
      outcomeMessages: string[],
    ): Promise<{ swapped: boolean; receipts: string[]; failurePanelShown?: boolean }> => {
      if (noCapture || captureSession === undefined) return { swapped: false, receipts: [] };
      let dismissedForSwap = false;
      const result = await executeResumeInjection({
        plan,
        captureSession,
        writeToPty: (data) => {
          ptyProcess.write(data);
        },
        onBeforeInject: () => {
          dismissedForSwap = true;
          inputState = finishExecuting(inputState);
          altScreen.leave();
          outputHold.flush();
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
            log: (message) => wrapperLog.info(message),
            logError: (message) => wrapperLog.warn(message),
          }),
        recordLineage: async ({ sessionId, threadId }) => {
          await safeRecordSessionThread(defaultLineageDbPath(), sessionId, threadId, (message) => {
            wrapperLog.warn(message);
          });
        },
        isTurnOpen: () => captureSession?.isTurnOpen() ?? false,
        logResume: (message) => {
          wrapperLog.info(message);
        },
        logHandoffError: (message) => {
          wrapperLog.warn(message);
        },
        ...(options.resumeWindowMs === undefined ? {} : { windowMs: options.resumeWindowMs }),
        ...(options.resumeConfirmExtraMs === undefined ? {} : { confirmExtraMs: options.resumeConfirmExtraMs }),
      });
      if (result.ok) {
        // No panel receipt on success: the swap receipt is a trailing
        // runtime-note line in the rebuilt rollout, rendered natively in the
        // resumed transcript.
        captureSession = result.captureSession;
        return { swapped: true, receipts: [] };
      }
      const failureReceipt =
        result.reason === "turn_open" ? formatResumeAbortTurnOpen(plan) : formatResumeFailure(plan);
      if (dismissedForSwap) {
        outputHold.hold();
        altScreen.enter();
        inputState = showReceipts(
          { ...createInputState(inputState.leaderByte), inPaste: inputState.inPaste },
          [...outcomeMessages, failureReceipt],
        );
        renderModalPanel();
        return { swapped: false, receipts: [], failurePanelShown: true };
      }
      return { swapped: false, receipts: [failureReceipt] };
    };

    const debugInput = createInputDebugLogger(process.env.CC_LHC_INPUT_DEBUG);

    // A modal-executed command settles here. Receipts go into the alt-screen
    // panel above a fresh prompt, screen still held — the panel owns its own
    // screen, so receipts stay readable whatever the main-screen TUI is doing.
    // One keypress (Esc/ctrl-C/leader) dismisses: leave the alt screen (the
    // terminal restores CC's layout exactly), then flush the held output.
    const settleCommand = (messages: string[]): void => {
      if (inputState.mode !== "executing") {
        // Modal was detached (ctrl-C) or force-cancelled (overflow) while the
        // command ran: the child owns the live screen again, so the receipt
        // goes to the wrapper log (doctrine — never write into CC's UI).
        for (const message of messages) wrapperLog.warn(`command receipt (modal dismissed early): ${message}`);
        return;
      }
      if (messages.length === 0) {
        inputState = finishExecuting(inputState);
        altScreen.leave();
        outputHold.flush();
        return;
      }
      inputState = showReceipts(inputState, messages);
      renderModalPanel();
    };

    const runModalCommand = (commandLine: string): void => {
      if (!commandGuard.tryAcquire()) {
        settleCommand([COMMAND_BUSY_MESSAGE]);
        return;
      }
      void dispatchLhcCommand(commandLine, commandRuntime())
        .then(async (outcome) => {
          const resume =
            outcome.restart === undefined
              ? null
              : await performResumeInjection(outcome.restart, outcome.messages);
          if (resume?.failurePanelShown === true) return;
          const receipts = settleReceipts(outcome.messages, resume);
          if (receipts === null) {
            // Confirmed swap: auto-dismiss — panel already left at injection;
            // settleCommand([]) is a no-op safety (alt-screen leave is idempotent).
            settleCommand([]);
            return;
          }
          settleCommand(receipts);
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
        if (action.kind === "enter_modal") {
          outputHold.hold();
          altScreen.enter();
        } else if (action.kind === "exit_modal") {
          // Leave BEFORE flushing: the terminal restores CC's main screen,
          // then the held bytes land on it in order.
          altScreen.leave();
          outputHold.flush();
        } else if (action.kind === "execute") runModalCommand(action.commandLine);
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
      const kind = inputState.escape?.kind;
      const holding = kind === "pending_esc" || (inputState.mode === "passthrough" && kind === "csi_candidate");
      if (!holding) return;
      pendingEscTimer = setTimeout(() => {
        pendingEscTimer = null;
        const resolved = resolveBareEsc(inputState);
        if (resolved === null) return;
        inputState = resolved.state;
        if (resolved.toPty !== undefined && resolved.toPty.length > 0)
          ptyProcess.write(resolved.toPty.toString("latin1"));
        applyActions(resolved.actions);
      }, PENDING_ESC_RESOLVE_MS);
      pendingEscTimer.unref?.();
    };

    const onStdinGone = (): void => {
      restoreIfModal();
    };

    const onStdinError = (cause: unknown): void => {
      // Restore the terminal, then let the error do what it always did
      // (propagate as an uncaught exception) — the exit hook's guarded leave
      // makes the rethrow safe.
      restoreIfModal();
      throw cause;
    };

    const forwardInput = (data: Buffer): void => {
      const result = processInputChunk(data, inputState);
      inputState = result.state;
      debugInput(data, inputState);
      if (result.toPty.length > 0) ptyProcess.write(result.toPty);
      applyActions(result.actions);
      renderModalPanel();
      armPendingEscTimer();
    };

    const onExit = async ({ exitCode, signal }: { exitCode: number; signal?: number }): Promise<void> => {
      if (exited) return;
      await teardownAndExit(signal !== undefined && signal !== 0 ? 128 + signal : (exitCode ?? 1));
    };

    ptyProcess.onData(forwardOutput);
    ptyProcess.onExit(onExit);
    stdin.on("data", forwardInput);
    // stdin ending/erroring has no wrapper lifecycle of its own (the child
    // and capture run on) — but with no input left there is no keypress to
    // dismiss a modal, so restore the terminal before those semantics apply.
    stdin.on("end", onStdinGone);
    stdin.on("close", onStdinGone);
    stdin.on("error", onStdinError);
  });
}
