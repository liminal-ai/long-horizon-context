/**
 * Wire protocol between a host client (`client.ts` is the reference) and the claude-lhc sidecar.
 * One JSON object per line on stdin (client → sidecar) and stdout (sidecar → client).
 *
 * The native Claude Agent SDK stream is forwarded unchanged inside `msg`. The two
 * adapter callbacks that cannot cross a process boundary (`canUseTool`,
 * `onUserDialog`) become `req`/`res` pairs originated by the sidecar. The SDK `Query`
 * controls become `req`/`res` pairs originated by the client: `method` is the `Query`
 * method name, `params` maps its SDK parameter names to values, and the `res` value is
 * what the SDK returned. `CONTROLS` in `controls.ts` lists every method claude-lhc
 * forwards, replays into later generations, or refuses, plus the LHC control
 * `setCompactPolicy` (`{ policy: { trigger, target } }`). An `end` frame says the host's input
 * ended: the sidecar exits once every prompt sent before it has its result. Closing stdin
 * closes the sidecar at once.
 *
 * A sidecar whose first frame is `op` runs one store operation instead of a session:
 * `forkSession`, `getSessionMessages` or `getSubagentMessages` with the SDK's arguments, or
 * `inspectSessions` with a list of session ids, answered by one `res` frame with the same id,
 * then exit.
 */
import type {
  ForkSessionOptions,
  GetSessionMessagesOptions,
  GetSubagentMessagesOptions,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ControlMethod } from "./controls.js";

/**
 * SDK `Options` with the non-serialisable members removed, plus the sidecar's own
 * `lhc` block, which never reaches the SDK:
 *   lhc.home — the LHC store directory (registry and thread files). Required.
 *   lhc.compact — the compact policy a new thread stores. A resumed thread keeps its own.
 *   lhc.forceRebuildFailure — every compact rebuild throws before touching LHC
 *   (proof scripts exercise the failure path with a live model; never set by t3code).
 * `resumeSessionAt` is a host rollback to that message. The sidecar records it in LHC
 * and never forwards it: projected lines carry fresh uuids, and the CLI fails a turn
 * whose resumeSessionAt names no line in the resumed file. `resumeDropsTurn` is refused: it
 * validates the CLI's own transcript, which a projected session does not share.
 */
export type WireOptions = Record<string, unknown> & { lhc: SidecarOptions; resumeSessionAt?: string };
export type SidecarOptions = {
  home: string;
  compact?: { trigger: number; target: number };
  forceRebuildFailure?: boolean;
};
export type LhcStore = { lhc: Pick<SidecarOptions, "home"> };
/**
 * What a store operation runs Claude with, in place of the host process's env and `claude` on PATH.
 * The SDK's session readers take no env, so in the host's own process they still read
 * CLAUDE_CONFIG_DIR from process.env; the `claude-lhc/client` operations run in a sidecar that
 * takes the operation's home as its own.
 */
export type OperationEnv = { env?: NodeJS.ProcessEnv; pathToClaudeCodeExecutable?: string };

/** What the store knows of one session id: the thread holding it and that thread's current session id. */
export type SessionInspection = { kind: "managed"; threadId: string; currentSessionId: string } | { kind: "unknown" };

export type WireForkOptions = Omit<ForkSessionOptions, "sessionStore"> & LhcStore & OperationEnv;
export type WireSessionMessagesOptions = Omit<GetSessionMessagesOptions, "sessionStore"> & LhcStore & OperationEnv;
export type WireSubagentMessagesOptions = Omit<GetSubagentMessagesOptions, "sessionStore"> & LhcStore & OperationEnv;

export type OperationFrame = { type: "op"; id: number } & (
  | { method: "forkSession"; args: [sessionId: string, options: WireForkOptions] }
  | { method: "getSessionMessages"; args: [sessionId: string, options: WireSessionMessagesOptions] }
  | { method: "getSubagentMessages"; args: [sessionId: string, agentId: string, options: WireSubagentMessagesOptions] }
  | { method: "inspectSessions"; args: [sessionIds: string[], options: LhcStore] }
);

export type SidecarRequestMethod = "canUseTool" | "onUserDialog";

export type DriverFrame =
  | { type: "start"; options: WireOptions }
  | { type: "user"; message: SDKUserMessage }
  | { type: "end" }
  | { type: "req"; id: number; method: ControlMethod; params: unknown }
  | { type: "res"; id: number; ok: true; value: unknown }
  | { type: "res"; id: number; ok: false; error: string }
  | { type: "abort"; id: number };

export type SidecarFrame =
  | { type: "msg"; message: SDKMessage }
  | { type: "req"; id: number; method: SidecarRequestMethod; params: unknown }
  | { type: "res"; id: number; ok: true; value: unknown }
  | { type: "res"; id: number; ok: false; error: string }
  | { type: "abort"; id: number }
  | { type: "error"; message: string };

export interface CanUseToolParams {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown;
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID?: string;
  agentID?: string;
}

export function encodeFrame(frame: DriverFrame | OperationFrame | SidecarFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeFrame<T>(line: string): T | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  return JSON.parse(trimmed) as T;
}

export function parseSidecarOptions(value: unknown): SidecarOptions {
  const block = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const home = block["home"];
  if (typeof home !== "string" || home.trim() === "") {
    throw new Error("lhc.home is required: pass the LHC store directory in the start options");
  }
  const compact = block["compact"];
  return {
    home,
    ...(compact !== undefined ? { compact: parseCompactPolicy(compact, "lhc.compact") } : {}),
    ...(block["forceRebuildFailure"] === true ? { forceRebuildFailure: true } : {}),
  };
}

export function parseCompactPolicy(value: unknown, field: string): { trigger: number; target: number } {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const { trigger, target } = record;
  const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (!positive(trigger) || !positive(target) || target >= trigger) {
    throw new Error(
      `${field} must be { trigger, target } with positive integers and target below trigger; received ${JSON.stringify(value)}`,
    );
  }
  return { trigger, target };
}
