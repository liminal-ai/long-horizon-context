import { createInterface } from "node:readline";
import type { ForkSessionResult, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { defaultSidecarCommand, type LhcOptions, spawnSidecar } from "../client.js";
import {
  decodeFrame,
  encodeFrame,
  type OperationFrame,
  type SessionInspection,
  type SidecarFrame,
  type WireForkOptions,
  type WireSessionMessagesOptions,
  type WireSubagentMessagesOptions,
} from "../protocol.js";

/**
 * The LHC store, the sidecar command that runs the operation (default `node <this package>/dist/sidecar.js`),
 * and the host's spawn for it, as on `query()`.
 */
export type LhcOperationStore = { lhc: { home: string } & Pick<LhcOptions, "spawn" | "spawnProcess"> };
export type LhcForkSessionOptions = Omit<WireForkOptions, "lhc"> & LhcOperationStore;
export type LhcSessionMessagesOptions = Omit<WireSessionMessagesOptions, "lhc"> & LhcOperationStore;
export type LhcSubagentMessagesOptions = Omit<WireSubagentMessagesOptions, "lhc"> & LhcOperationStore;
export type LhcForkSessionResult = ForkSessionResult & { headMessageId?: string };

const STDERR_TAIL_LINES = 20;

function operate<T>(frame: OperationFrame, { lhc }: LhcOperationStore): Promise<T> {
  return new Promise((resolve, reject) => {
    const stderr: string[] = [];
    let reply: Extract<SidecarFrame, { type: "res" }> | undefined;
    const command = lhc.spawn ?? defaultSidecarCommand();
    const child = spawnSidecar(command, lhc.spawnProcess);
    child.on("error", (cause) =>
      reject(new Error(`claude-lhc ${frame.method} sidecar failed to start (${command.command}): ${cause.message}`)),
    );
    if (child.stderr !== null)
      createInterface({ input: child.stderr }).on("line", (line) => {
        stderr.push(line);
        if (stderr.length > STDERR_TAIL_LINES) stderr.shift();
      });
    if (child.stdout !== null)
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
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(encodeFrame(frame));
  });
}

const wireStore = ({ lhc }: LhcOperationStore): WireForkOptions["lhc"] => ({ home: lhc.home });

export function forkSession(sessionId: string, options: LhcForkSessionOptions): Promise<LhcForkSessionResult> {
  return operate(
    { type: "op", id: 1, method: "forkSession", args: [sessionId, { ...options, lhc: wireStore(options) }] },
    options,
  );
}

export function getSessionMessages(sessionId: string, options: LhcSessionMessagesOptions): Promise<SessionMessage[]> {
  return operate(
    { type: "op", id: 1, method: "getSessionMessages", args: [sessionId, { ...options, lhc: wireStore(options) }] },
    options,
  );
}

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
    options,
  );
}

/** One sidecar start for the whole batch. Rejects with a store error when the registry cannot be read. */
export function inspectSessions(
  sessionIds: readonly string[],
  options: LhcOperationStore,
): Promise<SessionInspection[]> {
  return operate(
    { type: "op", id: 1, method: "inspectSessions", args: [[...sessionIds], { lhc: wireStore(options) }] },
    options,
  );
}
