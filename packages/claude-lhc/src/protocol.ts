/**
 * Wire protocol between the t3code Claude driver and the claude-lhc sidecar.
 * One JSON object per line on stdin (driver → sidecar) and stdout (sidecar → driver).
 *
 * The native Claude Agent SDK stream is forwarded unchanged inside `msg`. The two
 * adapter callbacks that cannot cross a process boundary (`canUseTool`,
 * `onUserDialog`) become `req`/`res` pairs originated by the sidecar; the query
 * controls (`setModel`, `setPermissionMode`, `setMaxThinkingTokens`, `interrupt`)
 * become `req`/`res` pairs originated by the driver. Closing stdin closes the
 * sidecar.
 */
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** SDK `Options` with the non-serialisable members removed. */
export type WireOptions = Record<string, unknown>;

export type DriverControlMethod = "setModel" | "setPermissionMode" | "setMaxThinkingTokens" | "interrupt";
export type SidecarRequestMethod = "canUseTool" | "onUserDialog";

export type DriverFrame =
  | { type: "start"; options: WireOptions }
  | { type: "user"; message: SDKUserMessage }
  | { type: "req"; id: number; method: DriverControlMethod; params: unknown }
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

export function encodeFrame(frame: DriverFrame | SidecarFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeFrame<T>(line: string): T | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  return JSON.parse(trimmed) as T;
}
