import { type IPty, spawn as defaultSpawn } from "@lydell/node-pty";

import {
  dispatchLhcCommand,
  formatCommandOutput,
  type LhcCommandRuntime,
  type SessionRestartPlan,
} from "../commands/dispatch.js";
import { startCaptureSession, type CaptureSession } from "../intake/session.js";
import { hasContinueFlag, parseResumeSessionId } from "../intake/argv.js";
import { defaultLineageDbPath, safeRecordSessionThread } from "../intake/lineage-db.js";
import { killAllInferenceChildren } from "../inference/claude-cli.js";
import { emptyCaptureStats, formatCaptureStatsLine } from "../stats.js";
import { COMMAND_BUSY_MESSAGE, CommandInFlightGuard } from "./command-guard.js";
import {
  createInterceptState,
  processInputChunk,
  type InterceptState,
} from "./intercept.js";
import { createInputDebugLogger } from "./input-debug.js";
import {
  executeResumeInjection,
  formatResumeFailure,
  formatResumeSuccess,
} from "./resume-injection.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM_NAME = "xterm-256color";
const SHOW_CURSOR = "\x1b[?25h";

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
  // window; everything still reaches stdout untouched.
  let outputTap: ((data: string) => void) | null = null;

  const forwardOutput = (data: string): void => {
    stdout.write(data);
    outputTap?.(data);
  };

  let interceptState: InterceptState = createInterceptState();

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
      stdin.removeListener("data", forwardInput);
      process.removeListener("SIGWINCH", handleSigwinch);
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      if (captureSession !== undefined) {
        await captureSession.stop().catch(() => {});
        printStats();
        killAllInferenceChildren();
      }
      cleanup();
      resolve(exitCode);
    };

    const performResumeInjection = async (plan: SessionRestartPlan): Promise<void> => {
      if (noCapture || captureSession === undefined) return;
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
            replayedPrefixLines: plan.rebuiltLineCount,
          }),
        recordLineage: async ({ sessionId, threadId }) => {
          await safeRecordSessionThread(defaultLineageDbPath(), sessionId, threadId, (message) => {
            stderr.write(`${message}\n`);
          });
        },
        logResume: (message) => {
          stderr.write(`${message}\n`);
        },
      });
      if (result.ok) {
        captureSession = result.captureSession;
        stdout.write(formatCommandOutput(formatResumeSuccess(plan)));
      } else {
        stdout.write(formatCommandOutput(formatResumeFailure(plan)));
      }
    };

    const runDispatch = (commandLine: string): void => {
      if (!commandGuard.tryAcquire()) {
        stdout.write(formatCommandOutput(COMMAND_BUSY_MESSAGE));
        return;
      }
      void dispatchLhcCommand(commandLine, commandRuntime())
        .then(async (outcome) => {
          for (const message of outcome.messages) {
            stdout.write(formatCommandOutput(message));
          }
          if (outcome.restart !== undefined) {
            await performResumeInjection(outcome.restart);
          }
        })
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          stdout.write(formatCommandOutput(`command error: ${message}`));
        })
        .finally(() => {
          commandGuard.release();
        });
    };

    const debugInput = createInputDebugLogger(process.env.CC_LHC_INPUT_DEBUG);

    const forwardInput = (data: Buffer): void => {
      const result = processInputChunk(data, interceptState);
      interceptState = result.state;
      debugInput(data, interceptState);
      if (result.toStdout !== "") stdout.write(result.toStdout);
      if (result.toPty.length > 0) ptyProcess.write(result.toPty);
      if (result.dispatch !== undefined) runDispatch(result.dispatch);
    };

    const onExit = async ({ exitCode, signal }: { exitCode: number; signal?: number }): Promise<void> => {
      if (exited) return;
      await teardownAndExit(signal !== undefined && signal !== 0 ? 128 + signal : exitCode ?? 1);
    };

    ptyProcess.onData(forwardOutput);
    ptyProcess.onExit(onExit);
    stdin.on("data", forwardInput);
  });
}
