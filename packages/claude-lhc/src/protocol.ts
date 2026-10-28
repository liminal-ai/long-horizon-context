/**
 * Wire protocol between the t3code Claude driver and the claude-lhc sidecar.
 * One JSON object per line on stdin (driver → sidecar) and stdout (sidecar → driver).
 *
 * The native Claude Agent SDK stream is forwarded unchanged inside `msg`. The two
 * adapter callbacks that cannot cross a process boundary (`canUseTool`,
 * `onUserDialog`) become `req`/`res` pairs originated by the sidecar; the query
 * controls (`setModel`, `setPermissionMode`, `setMaxThinkingTokens`, `interrupt`,
 * `setMcpServers`, `applyFlagSettings`, `stopTask`, `backgroundTasks`) become `req`/`res`
 * pairs originated by the driver. Closing stdin closes the sidecar.
 *
 * `setMcpServers` carries `{ servers }` and answers with the SDK's `McpSetServersResult`.
 * Like `Query.setMcpServers`, it replaces the servers added after start; servers from the
 * start frame stay. The retrieval server joins every set under its own name, and the set
 * carries into every later generation.
 *
 * `setModel` carries `{ model, settings? }`. When `settings` is present it holds the
 * compaction windows fitted to the new model (`autoCompactWindow`, `lhcLowerBound`), and
 * the sidecar compacts against them from then on.
 *
 * `applyFlagSettings` carries `{ settings }` and merges into the live generation's flag
 * settings like `Query.applyFlagSettings`. The merged layer is applied again to every
 * later generation. `stopTask` carries `{ taskId }`; `backgroundTasks` carries
 * `{ toolUseId? }` and answers with the SDK's boolean.
 */
import type {
  McpHttpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * SDK `Options` with the non-serialisable members removed, plus the sidecar's own
 * `lhc` block, which never reaches the SDK:
 *   lhc.forceRebuildFailure — every compact rebuild throws before touching LHC
 *   (proof scripts exercise the failure path with a live model; never set by t3code).
 * `resumeSessionAt` is a host rollback to that assistant message. The sidecar records
 * it in LHC and never forwards it: projected lines carry fresh uuids, and the CLI fails
 * a turn whose resumeSessionAt names no line in the resumed file.
 */
export type WireOptions = Record<string, unknown> & { lhc?: SidecarOptions; resumeSessionAt?: string };
export type SidecarOptions = { forceRebuildFailure?: boolean };

export type DriverControlMethod =
  | "setModel"
  | "setPermissionMode"
  | "setMaxThinkingTokens"
  | "interrupt"
  | "setMcpServers"
  | "applyFlagSettings"
  | "stopTask"
  | "backgroundTasks";
export type WireMcpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;
export type SetMcpServersParams = { servers: Record<string, WireMcpServerConfig> };
export type SetModelParams = { model?: string; settings?: Record<string, unknown> };
export type FlagSettings = Parameters<Query["applyFlagSettings"]>[0];
export type ApplyFlagSettingsParams = { settings: FlagSettings };
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
