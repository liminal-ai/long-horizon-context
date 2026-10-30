/**
 * Wire protocol between the t3code Claude driver and the claude-lhc sidecar.
 * One JSON object per line on stdin (driver → sidecar) and stdout (sidecar → driver).
 *
 * The native Claude Agent SDK stream is forwarded unchanged inside `msg`. The two
 * adapter callbacks that cannot cross a process boundary (`canUseTool`,
 * `onUserDialog`) become `req`/`res` pairs originated by the sidecar. The SDK `Query`
 * controls become `req`/`res` pairs originated by the driver: `method` is the `Query`
 * method name, `params` maps its SDK parameter names to values, and the `res` value is
 * what the SDK returned. `CONTROLS` in `controls.ts` lists every method claude-lhc
 * forwards, replays into later generations, or refuses, plus the LHC control
 * `setCompactPolicy` (`{ policy: { trigger, target } }`). Closing stdin closes the sidecar.
 */
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
 * whose resumeSessionAt names no line in the resumed file.
 */
export type WireOptions = Record<string, unknown> & { lhc: SidecarOptions; resumeSessionAt?: string };
export type SidecarOptions = {
  home: string;
  compact?: { trigger: number; target: number };
  forceRebuildFailure?: boolean;
};
/** The `lhc` block the exported session functions take beside the SDK's own options. */
export type LhcStore = { lhc: Pick<SidecarOptions, "home"> };

export type SidecarRequestMethod = "canUseTool" | "onUserDialog";

export type DriverFrame =
  | { type: "start"; options: WireOptions }
  | { type: "user"; message: SDKUserMessage }
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

export function encodeFrame(frame: DriverFrame | SidecarFrame): string {
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
