import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ForkSessionResult, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { defaultSidecarCommand, type SidecarCommand } from "../client.js";
import {
  decodeFrame,
  encodeFrame,
  type OperationFrame,
  type SidecarFrame,
  type WireForkOptions,
  type WireSessionMessagesOptions,
  type WireSubagentMessagesOptions,
} from "../protocol.js";

/** The LHC store, and the sidecar command that runs the operation (default `node <this package>/dist/sidecar.js`). */
export type LhcOperationStore = { lhc: { home: string; spawn?: SidecarCommand } };
export type LhcForkSessionOptions = Omit<WireForkOptions, "lhc"> & LhcOperationStore;
export type LhcSessionMessagesOptions = Omit<WireSessionMessagesOptions, "lhc"> & LhcOperationStore;
export type LhcSubagentMessagesOptions = Omit<WireSubagentMessagesOptions, "lhc"> & LhcOperationStore;
export type LhcForkSessionResult = ForkSessionResult & { headMessageId?: string };

const STDERR_TAIL_LINES = 20;

function operate<T>(frame: OperationFrame, command: SidecarCommand = defaultSidecarCommand()): Promise<T> {
  return new Promise((resolve, reject) => {
    const stderr: string[] = [];
    let reply: Extract<SidecarFrame, { type: "res" }> | undefined;
    const child = spawn(command.command, [...(command.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: command.env ?? process.env,
      windowsHide: true,
    });
    child.on("error", (cause) =>
      reject(new Error(`claude-lhc ${frame.method} sidecar failed to start (${command.command}): ${cause.message}`)),
    );
    createInterface({ input: child.stderr }).on("line", (line) => {
      stderr.push(line);
      if (stderr.length > STDERR_TAIL_LINES) stderr.shift();
    });
    createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
      try {
        const sent = decodeFrame<SidecarFrame>(line);
        if (sent?.type === "res" && sent.id === frame.id) reply = sent;
      } catch {}
    });
    child.on("close", (code, signal) => {
      if (reply?.ok === true) resolve(reply.value as T);
      else if (reply?.ok === false) reject(new Error(reply.error));
      else {
        const tail = stderr.length === 0 ? "" : `\n${stderr.join("\n")}`;
        reject(
          new Error(
            `claude-lhc ${frame.method} sidecar exited (code ${code ?? "null"}, signal ${signal ?? "none"}) with no result${tail}`,
          ),
        );
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(encodeFrame(frame));
  });
}

const wireStore = ({ lhc }: LhcOperationStore): WireForkOptions["lhc"] => ({ home: lhc.home });

/** claude-lhc's `forkSession`, run in a short-lived sidecar with `options.env` and `options.pathToClaudeCodeExecutable`. */
export function forkSession(sessionId: string, options: LhcForkSessionOptions): Promise<LhcForkSessionResult> {
  return operate(
    { type: "op", id: 1, method: "forkSession", args: [sessionId, { ...options, lhc: wireStore(options) }] },
    options.lhc.spawn,
  );
}

/** claude-lhc's `getSessionMessages`, run in a short-lived sidecar that reads under `options.env`'s Claude home. */
export function getSessionMessages(sessionId: string, options: LhcSessionMessagesOptions): Promise<SessionMessage[]> {
  return operate(
    { type: "op", id: 1, method: "getSessionMessages", args: [sessionId, { ...options, lhc: wireStore(options) }] },
    options.lhc.spawn,
  );
}

/** claude-lhc's `getSubagentMessages`, run in a short-lived sidecar that reads under `options.env`'s Claude home. */
export function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options: LhcSubagentMessagesOptions,
): Promise<SessionMessage[]> {
  return operate(
    {
      type: "op",
      id: 1,
      method: "getSubagentMessages",
      args: [sessionId, agentId, { ...options, lhc: wireStore(options) }],
    },
    options.lhc.spawn,
  );
}
