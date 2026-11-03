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

export type CompactRequest = { sessionId: string; trigger: string; target: number };

export type CompactAnswer =
  | { kind: "view"; messages: BuiltMessage[]; isMidTurn: boolean; viewTokens: number }
  | { kind: "native"; reason: string };

export type RetrieveRequest = { sessionId: string; op: RetrievalOp; ids: string[]; fromToken?: number };
export type RetrieveAnswer = { text: string; isError: boolean };

/**
 * Claude Code stops a turn after three refills within three turns of a
 * compact. A context that leaves less than a quarter of the trigger free right
 * after compacting refills in a few steps, so it is called out first.
 */
/** A view that, with Claude Code's fixed overhead, still reaches the trigger reduces nothing and is not installed. */
export function isViewUseless(viewTokens: number, fixedOverhead: number, trigger: number): boolean {
  return viewTokens + fixedOverhead >= trigger;
}

export function isReductionInadequate(contextTokens: number, trigger: number): boolean {
  return contextTokens > 0.75 * trigger;
}
