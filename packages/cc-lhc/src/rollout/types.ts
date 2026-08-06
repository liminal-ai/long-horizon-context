/** Approximate Claude Code rollout JSONL shapes (2.1.x; may drift). */

export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface TextBlock extends ContentBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock extends ContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock extends ContentBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export interface ThinkingBlock extends ContentBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ConversationMessage {
  role?: string;
  model?: string;
  content?: ContentBlock[] | string;
  [key: string]: unknown;
}

export type RolloutLineType = "user" | "assistant" | "summary" | "file-history-snapshot" | string;

export interface RolloutLineItem {
  type?: RolloutLineType;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string | null;
  isSidechain?: boolean;
  message?: ConversationMessage;
  summary?: string;
  attachment?: unknown;
  [key: string]: unknown;
}

export interface ParseDiagnostic {
  kind: "parse_error";
  raw: string;
  error: string;
}

export interface ParsedRolloutLine {
  kind: "line";
  item: RolloutLineItem;
  raw: string;
}

export type WatcherEmission = ParsedRolloutLine | ParseDiagnostic;
