import type { RetrievalOp } from "claude-adapter";

/** Claude Code's `SessionMessage` as a hook builds it: no engine `handle`, so a resume never reloads what it replaced. */
export type BuiltToolUse = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: true;
};
export type BuiltToolResult = { tool_use_id: string; text: string; isError: boolean };
export type BuiltMessage = {
  role: "user" | "assistant";
  text: string;
  toolUses: BuiltToolUse[];
  toolResults?: BuiltToolResult[];
};

/** `prune` installs the current view after core prune moves the visibility boundary, with no core compact. */
export type CompactOp = "compact" | "prune";

/**
 * `guard` is the auto-compact trigger and what Claude Code counts beside the
 * conversation, when its breakdown names both: a view that does not get below
 * the trigger with that fixed context is answered native, before any install
 * receipt exists for it.
 */
export type CompactRequest = {
  sessionId: string;
  trigger: string;
  target: number;
  op?: CompactOp;
  guard?: { trigger: number; fixed: number };
};

export type CompactAnswer =
  | { kind: "view"; messages: BuiltMessage[]; isMidTurn: boolean; viewTokens: number }
  | { kind: "native"; reason: string }
  | { kind: "unchanged"; reason: string };

export type RetrieveRequest = { sessionId: string; op: RetrievalOp; ids: string[]; fromToken?: number };
export type RetrieveAnswer = { text: string; isError: boolean };

export const kilo = (tokens: number): string => (tokens < 1000 ? `${tokens}` : `${Math.round(tokens / 1000)}k`);
