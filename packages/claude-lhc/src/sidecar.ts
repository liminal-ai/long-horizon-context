import { createInterface } from "node:readline";
import { forkSession } from "./fork.js";
import { createSidecar, type Sidecar } from "./frames.js";
import { getSessionMessages, getSubagentMessages } from "./history.js";
import { decodeFrame, encodeFrame, type OperationEnv, type OperationFrame, type SidecarFrame } from "./protocol.js";

const log = (line: string): void => {
  process.stderr.write(`[claude-lhc] ${line}\n`);
};

const exit = async (code: number): Promise<void> => {
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(code);
};

const CLAUDE_HOME_VARS = ["CLAUDE_CONFIG_DIR", "HOME", "USERPROFILE"] as const;

// The SDK's session readers and renameSession take no env: they find the Claude home from
// process.env's CLAUDE_CONFIG_DIR, else os.homedir(), which reads HOME or USERPROFILE.
function adoptOperationClaudeHome({ env }: OperationEnv): void {
  if (env === undefined) return;
  for (const name of CLAUDE_HOME_VARS) {
    if (env[name] !== undefined) process.env[name] = env[name];
    else if (name === "CLAUDE_CONFIG_DIR") delete process.env[name];
  }
}

function runOperation(frame: OperationFrame): Promise<unknown> {
  adoptOperationClaudeHome(frame.args[frame.args.length - 1] as OperationEnv);
  switch (frame.method) {
    case "forkSession":
      return forkSession(...frame.args);
    case "getSessionMessages":
      return getSessionMessages(...frame.args);
    case "getSubagentMessages":
      return getSubagentMessages(...frame.args);
  }
}

let operation: OperationFrame | undefined;
const answer = async (reply: Extract<SidecarFrame, { type: "res" }>): Promise<void> => {
  process.stdout.write(encodeFrame(reply));
  await exit(reply.ok ? 0 : 1);
};
const failOperation = (frame: OperationFrame, message: string): Promise<void> =>
  answer({ type: "res", id: frame.id, ok: false, error: message });

function readOperation(line: string): OperationFrame | null {
  try {
    const frame = decodeFrame<{ type?: unknown }>(line);
    return frame?.type === "op" ? (frame as OperationFrame) : null;
  } catch {
    return null;
  }
}

let sidecar: Sidecar | undefined;
const session = (): Sidecar =>
  (sidecar ??= createSidecar({ write: (frame) => process.stdout.write(encodeFrame(frame)), log, exit }));

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  if (operation !== undefined) return;
  if (sidecar === undefined && line.trim() !== "") {
    const frame = readOperation(line);
    if (frame !== null) {
      operation = frame;
      runOperation(frame).then(
        (value) => answer({ type: "res", id: frame.id, ok: true, value }),
        (cause) => failOperation(frame, cause instanceof Error ? cause.message : String(cause)),
      );
      return;
    }
  }
  session().line(line);
});
lines.on("close", () => {
  if (operation === undefined) session().inputClosed();
});
process.on("SIGTERM", () => void (operation === undefined ? session().shutdown(0) : exit(1)));
const crashed = (message: string): void => {
  if (operation !== undefined) void failOperation(operation, `sidecar crashed: ${message}`);
  else session().fail(`sidecar crashed: ${message}`);
};
process.on("uncaughtException", (cause) => crashed(cause.message));
process.on("unhandledRejection", (cause) => crashed(cause instanceof Error ? cause.message : String(cause)));
