import { spawn as defaultSpawn, type IPty } from "@lydell/node-pty";

import {
  CAPTURE_NOT_READY_MESSAGE,
  formatReceiptLine,
  type LhcCommandCtx,
  type SwapSettleInfo,
} from "../commands/context.js";
import { dispatchLhcCommand } from "../commands/dispatch.js";
import { killAllInferenceChildren } from "../inference/claude-cli.js";
import {
  hasResumeLastIntent,
  parseCodexResumeIntent,
  resumeSessionIdFromIntent,
} from "../intake/argv.js";
import { defaultLineageDbPath } from "../intake/lineage-db.js";
import { type CaptureSession, type CaptureSessionDeps, startCaptureSession } from "../intake/session.js";
import { resolveCodexBin } from "../shared/codex-bin.js";
import { formatCaptureStatsLine } from "../stats.js";
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
import {
  DEFAULT_SWAP_TERMINATE_GRACE_MS,
  executeSessionSwap,
  terminateChild,
  type ChildExit,
  type SwapChildControl,
  type SwapChildHandle,
} from "./session-swap.js";
import { createWrapperLog, type WrapperLog } from "./wrapper-log.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM_NAME = "xterm-256color";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * Cap on pty output held while the modal is open. Codex keeps running while
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
/** Cap for stdin buffered while no live PTY child (kill→respawn window). */
export const PTY_STDIN_BUFFER_CAP_BYTES = 4 * 1024;

/**
 * What the panel shows when a command settles. null means AUTO-DISMISS: a
 * confirmed swap already carries its receipt as a runtime note rendered
 * natively in the respawned transcript, so the panel closes itself and the
 * user watches the session repaint. Refusals, errors, no-ops, and
 * status/stats keep the stay-until-dismissed rhythm.
 */
export function settleReceipts(outcomeMessages: string[], swapSettle: SwapSettleInfo | undefined): string[] | null {
  if (swapSettle === undefined) return outcomeMessages;
  if (swapSettle.confirmed) return null;
  if (swapSettle.failurePanelShown === true || swapSettle.failureSettled === true) return null;
  return outcomeMessages;
}

export type PtySpawn = typeof defaultSpawn;

export interface SpawnedCodexChild extends SwapChildHandle {
  pty: IPty;
  argv: string[];
}

export interface RunChildControl {
  getCurrent(): SpawnedCodexChild;
  markSwapKill(child: SpawnedCodexChild): void;
  unmarkSwapKill(child: SpawnedCodexChild): void;
  spawnReplacement(argv: string[]): SpawnedCodexChild;
}

export type RunOptions = {
  codexBin?: string;
  spawnPty?: PtySpawn;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  noCapture?: boolean;
  noInference?: boolean;
  /** Test hook: forwarded to capture session (e.g. codexHome override). */
  captureDeps?: Partial<CaptureSessionDeps>;
  /** Test hook / future command seam: exposes child lifecycle replacement controls. */
  onChildControl?: (control: RunChildControl) => void;
  /** Test hook: substitute the wrapper log (defaults to ~/.codex-lhc/wrapper.log). */
  wrapperLog?: WrapperLog;
  /** Test hook: cap held pty output while the modal is open (defaults to 4 MiB). */
  outputHoldCapBytes?: number;
  /** Test hook: override modal command dispatch. */
  dispatchLhcCommand?: typeof dispatchLhcCommand;
  /** Test hook: stub session swap after modal dismiss. */
  testExecuteSessionSwap?: typeof executeSessionSwap;
};

export { resolveCodexBin };

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

export interface SpawnChildOptions {
  codexBin: string;
  argv: string[];
  spawnPty: PtySpawn;
  onData: (data: string) => void;
  cols: number;
  rows: number;
  onExit: (child: SpawnedCodexChild, exit: ChildExit) => void;
}

export function spawnChild(options: SpawnChildOptions): SpawnedCodexChild {
  const ptyProcess = options.spawnPty(options.codexBin, options.argv, {
    name: TERM_NAME,
    cols: options.cols,
    rows: options.rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  let alive = true;
  let exitValue: ChildExit | undefined;
  const waiters: Array<(value: ChildExit) => void> = [];

  const child: SpawnedCodexChild = {
    pty: ptyProcess,
    argv: [...options.argv],
    kill(signal: NodeJS.Signals): void {
      ptyProcess.kill(signal);
    },
    waitForExit(): Promise<ChildExit> {
      if (exitValue !== undefined) return Promise.resolve(exitValue);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    isAlive(): boolean {
      return alive;
    },
  };

  ptyProcess.onData((data) => {
    options.onData(data);
  });
  ptyProcess.onExit(({ exitCode, signal }) => {
    alive = false;
    exitValue = { exitCode: exitCode ?? 1, ...(signal === undefined ? {} : { signal }) };
    for (const resolve of waiters.splice(0)) resolve(exitValue);
    options.onExit(child, exitValue);
  });

  return child;
}

export function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const codexBin = options.codexBin ?? resolveCodexBin();
  const spawnPty = options.spawnPty ?? defaultSpawn;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const noCapture = options.noCapture === true;
  const noInference = options.noInference === true || process.env.CODEX_LHC_NO_INFERENCE === "1";
  const resumeIntent = parseCodexResumeIntent(argv);
  const resumeSessionId = resumeSessionIdFromIntent(resumeIntent);
  const resumeLast = hasResumeLastIntent(resumeIntent);
  const commandDispatch = options.dispatchLhcCommand ?? dispatchLhcCommand;

  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;
  const startedAt = new Date();

  // Doctrine: the wrapper NEVER writes raw bytes into a UI it does not own.
  // While the child owns the terminal, diagnostics go to the wrapper log
  // (surface (c)); `status` reports the warning count so nothing is lost.
  const wrapperLog = options.wrapperLog ?? createWrapperLog();

  let exited = false;
  let captureSession: CaptureSession | undefined;
  let currentChild: SpawnedCodexChild | undefined;
  let childControl: RunChildControl | undefined;
  const swapKilled = new WeakSet<SpawnedCodexChild>();
  const commandGuard = new CommandInFlightGuard();
  let dismissedModalGeneration = 0;
  /** While true, stdin is buffered instead of forwarded to the terminating child. */
  let swapRespawnPending = false;

  const altScreen = createAltScreenGuard((data) => stdout.write(data));

  // Exit stats print on stderr only from teardown, AFTER the child has
  // exited and the screen is back with the shell — legitimate surface (d).
  const printExitStats = (): void => {
    if (captureSession === undefined) return;
    stderr.write(`${formatCaptureStatsLine(captureSession.stats)}\n`);
  };

  // SIGUSR1 can fire at any moment while codex owns the screen: the stats
  // snapshot goes to the wrapper log, never the terminal.
  const onSigusr1 = (): void => {
    if (captureSession === undefined) return;
    wrapperLog.info(formatCaptureStatsLine(captureSession.stats));
  };

  if (!noCapture) {
    captureSession = startCaptureSession({
      startedAt,
      noInference,
      lineageDbPath: defaultLineageDbPath(),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(resumeLast ? { resumeLast: true } : {}),
      log: (message) => wrapperLog.info(message),
      logError: (message) => wrapperLog.warn(message),
      ...options.captureDeps,
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

  const leaderByte = resolveLeaderByte(process.env.CODEX_LHC_LEADER, (message) => {
    wrapperLog.warn(message);
  });
  let inputState: InputState = createInputState(leaderByte);
  /** Bumped on every modal entry; tags dismiss-at-respawn so late failures reopen only if still idle. */
  let modalGeneration = 0;

  const outputHold = new OutputHold(
    options.outputHoldCapBytes ?? OUTPUT_HOLD_CAP_BYTES,
    (data) => stdout.write(data),
    () => {
      inputState = forceResetInput(inputState);
      altScreen.leave();
      wrapperLog.warn(OUTPUT_HOLD_OVERFLOW_MESSAGE);
      outputHold.flush();
    },
  );

  const forwardOutput = (data: string): void => {
    outputHold.feed(data);
  };

  const dismissModalForRespawn = (): void => {
    swapRespawnPending = true;
    dismissedModalGeneration = modalGeneration;
    inputState = finishExecuting(inputState);
    altScreen.leave();
    outputHold.flush();
  };

  const buildCommandCtx = (): LhcCommandCtx | undefined => {
    if (noCapture || captureSession === undefined || childControl === undefined) return undefined;
    const cmdCtx = captureSession.getCommandContext();
    const rollout = captureSession.getRolloutInfo();
    const swapChild: SwapChildControl = {
      current: () => childControl!.getCurrent(),
      spawn: async (nextArgv) => {
        const child = childControl!.spawnReplacement(nextArgv);
        childControl!.markSwapKill(child);
        return child;
      },
      markSwapKill: (child) => childControl!.markSwapKill(child as SpawnedCodexChild),
      unmarkSwapKill: (child) => childControl!.unmarkSwapKill(child as SpawnedCodexChild),
    };
    return {
      captureDisabled: false,
      stats: captureSession.stats,
      sdk: cmdCtx.sdk,
      threadRef: cmdCtx.threadRef,
      cwd: process.cwd(),
      sourceRolloutPath: rollout.path,
      sourceSessionId: rollout.sessionId,
      isTurnOpen: () => captureSession!.isTurnOpen(),
      session: captureSession,
      warnings: { count: wrapperLog.warningCount(), logPath: wrapperLog.path },
      swap: {
        child: swapChild,
        markSwapKill: (child) => childControl!.markSwapKill(child as SpawnedCodexChild),
        executeSessionSwap: options.testExecuteSessionSwap ?? executeSessionSwap,
        onBeforeRespawn: dismissModalForRespawn,
        onSwapFailureAfterDismiss: (failureReceipt, outcomeMessages, options) => {
          const idlePassthrough =
            inputState.mode === "passthrough" && modalGeneration === dismissedModalGeneration;
          if (!idlePassthrough) {
            wrapperLog.warn(`swap failed after panel dismissal (user panel active): ${failureReceipt}`);
            return { confirmed: false, dismissedForRespawn: true, failureSettled: true };
          }
          if (options?.terminalExit === true) {
            return {
              confirmed: false,
              dismissedForRespawn: true,
              failureSettled: true,
              exitReport: [...outcomeMessages, failureReceipt],
            };
          }
          outputHold.hold();
          altScreen.enter();
          inputState = showReceipts(
            { ...createInputState(inputState.leaderByte), inPaste: inputState.inPaste },
            [...outcomeMessages, failureReceipt],
          );
          renderModalPanel();
          return { confirmed: false, dismissedForRespawn: true, failurePanelShown: true };
        },
        noInference,
        ...(options.captureDeps === undefined ? {} : { captureDeps: options.captureDeps }),
        lineageDbPath: defaultLineageDbPath(),
      },
      print: () => {},
      log: (message) => {
        wrapperLog.info(message);
      },
      logError: (message) => {
        wrapperLog.warn(message);
      },
    };
  };

  const renderModalPanel = (): void => {
    if (inputState.mode === "passthrough") return;
    stdout.write(renderPanel(inputState, stdout.columns ?? DEFAULT_COLS, stdout.rows ?? DEFAULT_ROWS));
  };

  const handleSigwinch = (): void => {
    if (currentChild !== undefined) onTerminalResize(currentChild.pty, stdout);
    renderModalPanel();
  };
  process.on("SIGWINCH", handleSigwinch);

  const restoreIfModal = (): void => {
    if (!altScreen.active && inputState.mode === "passthrough") return;
    inputState = forceResetInput(inputState);
    altScreen.leave();
    outputHold.flush();
  };

  const forwardSignal = (signal: NodeJS.Signals): void => {
    restoreIfModal();
    if (!exited && currentChild !== undefined) {
      currentChild.kill(signal);
    }
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  process.on("SIGHUP", forwardSignal);

  return new Promise((resolve) => {
    let pendingExitReport: string[] | undefined;

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
      process.removeListener("exit", cleanup);
      altScreen.leave();
      outputHold.flush();
      if (captureSession !== undefined) {
        await captureSession.stop().catch(() => {});
        printExitStats();
        killAllInferenceChildren();
      }
      if (pendingExitReport !== undefined) {
        if (currentChild !== undefined && currentChild.isAlive()) {
          await terminateChild(
            currentChild,
            (child) => {
              swapKilled.add(child as SpawnedCodexChild);
            },
            (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            DEFAULT_SWAP_TERMINATE_GRACE_MS,
          );
        }
        for (const line of pendingExitReport) {
          stderr.write(`${formatReceiptLine(line)}\n`);
        }
        pendingExitReport = undefined;
      }
      cleanup();
      resolve(exitCode);
    };

    const settleCommand = (messages: string[]): void => {
      if (inputState.mode !== "executing") {
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
      const ctx = buildCommandCtx();
      if (ctx === undefined) {
        settleCommand([noCapture ? "capture disabled" : CAPTURE_NOT_READY_MESSAGE]);
        commandGuard.release();
        return;
      }
      void commandDispatch(commandLine, ctx)
        .then((result) => {
          if (result.captureSession !== undefined) captureSession = result.captureSession;
          if (result.swapSettle?.exitReport !== undefined) {
            pendingExitReport = result.swapSettle.exitReport;
          }
          if (result.swapSettle?.failurePanelShown === true || result.swapSettle?.failureSettled === true) {
            if (result.wrapperExitCode !== undefined) {
              void teardownAndExit(result.wrapperExitCode);
            }
            return;
          }
          const receipts = settleReceipts(result.messages, result.swapSettle);
          if (receipts === null) {
            settleCommand([]);
            if (result.wrapperExitCode !== undefined) {
              void teardownAndExit(result.wrapperExitCode);
            }
            return;
          }
          settleCommand(receipts);
          if (result.wrapperExitCode !== undefined) {
            void teardownAndExit(result.wrapperExitCode);
          }
        })
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          settleCommand([`command error: ${message}`]);
        })
        .finally(() => {
          swapRespawnPending = false;
          commandGuard.release();
        });
    };

    const applyActions = (actions: ReturnType<typeof processInputChunk>["actions"]): void => {
      for (const action of actions) {
        if (action.kind === "enter_modal") {
          modalGeneration += 1;
          outputHold.hold();
          altScreen.enter();
        } else if (action.kind === "exit_modal") {
          altScreen.leave();
          outputHold.flush();
        } else if (action.kind === "execute") runModalCommand(action.commandLine);
      }
    };

    let pendingEscTimer: NodeJS.Timeout | null = null;
    let ptyStdinBuffer = Buffer.alloc(0);

    const bufferPtyStdin = (data: Buffer | string): void => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length === 0) return;
      const combined = Buffer.concat([ptyStdinBuffer, chunk]);
      ptyStdinBuffer =
        combined.length <= PTY_STDIN_BUFFER_CAP_BYTES
          ? combined
          : combined.subarray(combined.length - PTY_STDIN_BUFFER_CAP_BYTES);
    };

    const flushPtyStdinBuffer = (child: SpawnedCodexChild): void => {
      if (ptyStdinBuffer.length === 0) return;
      const pending = ptyStdinBuffer;
      if (child.isAlive()) {
        try {
          child.pty.write(pending);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          wrapperLog.warn(`stdin flush to replacement failed; ${pending.length} bytes dropped: ${detail}`);
        }
      }
      ptyStdinBuffer = Buffer.alloc(0);
    };

    const writeToChildPty = (data: Buffer | string): void => {
      if (swapRespawnPending) {
        bufferPtyStdin(data);
        return;
      }
      if (currentChild !== undefined && currentChild.isAlive()) {
        try {
          currentChild.pty.write(data);
        } catch (err) {
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const detail = err instanceof Error ? err.message : String(err);
          wrapperLog.warn(`pty write failed; ${chunk.length} bytes buffered: ${detail}`);
          bufferPtyStdin(data);
        }
        return;
      }
      bufferPtyStdin(data);
    };

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
        if (resolved.toPty !== undefined && resolved.toPty.length > 0) writeToChildPty(resolved.toPty);
        applyActions(resolved.actions);
      }, PENDING_ESC_RESOLVE_MS);
      pendingEscTimer.unref?.();
    };

    const onStdinGone = (): void => {
      restoreIfModal();
    };

    const onStdinError = (cause: unknown): void => {
      restoreIfModal();
      throw cause;
    };

    const forwardInput = (data: Buffer): void => {
      const result = processInputChunk(data, inputState);
      inputState = result.state;
      debugInput(data, inputState);
      if (result.toPty.length > 0) writeToChildPty(result.toPty);
      applyActions(result.actions);
      renderModalPanel();
      armPendingEscTimer();
    };

    const onExit = async (child: SpawnedCodexChild, { exitCode, signal }: ChildExit): Promise<void> => {
      if (exited) return;
      if (swapKilled.has(child)) {
        swapKilled.delete(child);
        return;
      }
      if (currentChild === undefined || child !== currentChild) return;
      const numericSignal = typeof signal === "number" ? signal : undefined;
      await teardownAndExit(numericSignal !== undefined && numericSignal !== 0 ? 128 + numericSignal : (exitCode ?? 1));
    };

    const spawnReplacement = (nextArgv: string[]): SpawnedCodexChild => {
      currentChild = spawnChild({
        codexBin,
        argv: nextArgv,
        spawnPty,
        onData: forwardOutput,
        cols,
        rows,
        onExit: (replacement, exit) => {
          void onExit(replacement, exit);
        },
      });
      swapRespawnPending = false;
      flushPtyStdinBuffer(currentChild);
      return currentChild;
    };

    const debugInput = createInputDebugLogger(process.env.CODEX_LHC_INPUT_DEBUG);

    currentChild = spawnReplacement(argv);
    childControl = {
      getCurrent: () => {
        if (currentChild === undefined) throw new Error("codex child not spawned");
        return currentChild;
      },
      markSwapKill: (child) => {
        swapKilled.add(child);
      },
      unmarkSwapKill: (child) => {
        swapKilled.delete(child);
      },
      spawnReplacement,
    };
    options.onChildControl?.(childControl);
    stdin.on("data", forwardInput);
    stdin.on("end", onStdinGone);
    stdin.on("close", onStdinGone);
    stdin.on("error", onStdinError);
  });
}
