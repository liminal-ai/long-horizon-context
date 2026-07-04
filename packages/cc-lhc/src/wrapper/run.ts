import { type IPty, spawn as defaultSpawn } from "@lydell/node-pty";

import { startCaptureSession, type CaptureSession } from "../intake/session.js";
import { killAllInferenceChildren } from "../inference/claude-cli.js";
import { formatCaptureStatsLine } from "../stats.js";

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

  const cols = stdout.columns ?? DEFAULT_COLS;
  const rows = stdout.rows ?? DEFAULT_ROWS;
  const startedAt = new Date();

  const ptyProcess = spawnPty(claudeBin, argv, {
    name: TERM_NAME,
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  let exited = false;
  let captureSession: CaptureSession | undefined;

  const printStats = (): void => {
    if (captureSession === undefined) return;
    stderr.write(`${formatCaptureStatsLine(captureSession.stats)}\n`);
  };

  const onSigusr1 = (): void => {
    printStats();
  };

  if (!noCapture) {
    captureSession = startCaptureSession({ startedAt, noInference });
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

  const forwardOutput = (data: string): void => {
    stdout.write(data);
  };

  const forwardInput = (data: Buffer): void => {
    ptyProcess.write(data);
  };

  ptyProcess.onData(forwardOutput);
  stdin.on("data", forwardInput);

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
    ptyProcess.onExit(async ({ exitCode, signal }) => {
      exited = true;
      stdin.removeListener("data", forwardInput);
      process.removeListener("SIGWINCH", handleSigwinch);
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);

      if (captureSession !== undefined) {
        await captureSession.stop();
        printStats();
        killAllInferenceChildren();
      }

      cleanup();

      if (signal !== undefined && signal !== 0) {
        resolve(128 + signal);
      } else {
        resolve(exitCode ?? 1);
      }
    });
  });
}
