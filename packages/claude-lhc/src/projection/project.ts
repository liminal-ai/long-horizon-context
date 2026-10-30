import { randomUUID } from "node:crypto";
import type { SessionAssistantPart, SessionThreadView, SessionThreadViewEntry } from "lhc";

export interface ProjectionStamp {
  sessionId: string;
  cwd: string;
  version: string;
  permissionMode: string;
  model: string;
  gitBranch?: string;
}

export type NativeEntry = Record<string, unknown>;

export const FALLBACK_CLAUDE_CODE_VERSION = "2.1.259";
export const FALLBACK_PROJECTION_MODEL = "claude-sonnet-5";

export type ThinkingRebuildArm = "signed_verbatim" | "omit";
export const SELECTED_THINKING_REBUILD_ARM: ThinkingRebuildArm = "signed_verbatim";

const DANGLING_RESULT = "[tool result unavailable: the session was interrupted before this call completed]";

export function projectView(
  view: SessionThreadView,
  stamp: ProjectionStamp,
  arm: ThinkingRebuildArm = SELECTED_THINKING_REBUILD_ARM,
): NativeEntry[] {
  const now = new Date().toISOString();
  const lines: NativeEntry[] = [];
  let parent: string | null = null;
  let model = stamp.model;
  const openCalls = new Set<string>();

  const base = (): NativeEntry => ({
    parentUuid: parent,
    isSidechain: false,
    userType: "external",
    entrypoint: "sdk-ts",
    cwd: stamp.cwd,
    sessionId: stamp.sessionId,
    version: stamp.version,
    gitBranch: stamp.gitBranch ?? "",
    timestamp: now,
  });
  const push = (line: NativeEntry): void => {
    const uuid = randomUUID();
    lines.push({ ...line, uuid });
    parent = uuid;
  };
  const userText = (content: string | NativeEntry[]): void =>
    push({
      ...base(),
      type: "user",
      message: { role: "user", content },
      permissionMode: stamp.permissionMode,
      promptSource: "sdk",
    });
  const toolResult = (toolCallId: string, content: string | NativeEntry[], isError: boolean): void => {
    openCalls.delete(toolCallId);
    push({
      ...base(),
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: toolCallId, type: "tool_result", content, is_error: isError }],
      },
    });
  };
  const settleOpenCalls = (): void => {
    for (const id of [...openCalls]) toolResult(id, DANGLING_RESULT, true);
  };

  for (const entry of view.entries) {
    if (!("role" in entry)) {
      if (entry.kind === "model_change" && entry.modelId !== "") model = entry.modelId;
      continue;
    }
    if (entry.role === "user") {
      settleOpenCalls();
      userText(entry.blocks ?? entry.content);
      continue;
    }
    if (entry.role === "toolResult") {
      toolResult(entry.toolCallId, entry.blocks ?? entry.content, entry.isError === true);
      continue;
    }
    settleOpenCalls();
    const blocks = entry.content.map((part) => nativeBlock(part, arm)).filter((b): b is NativeEntry => b !== null);
    if (blocks.length === 0) continue;
    const stop = blocks.some((b) => b["type"] === "tool_use") ? "tool_use" : "end_turn";
    const id = `msg_${randomUUID().replace(/-/g, "")}`;
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    for (const [index, block] of blocks.entries()) {
      if (block["type"] === "tool_use") openCalls.add(String(block["id"]));
      push({
        ...base(),
        type: "assistant",
        apiBlockIndex: index,
        requestId,
        message: {
          model: entry.model ?? model,
          id,
          type: "message",
          role: "assistant",
          content: [block],
          stop_reason: stop,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
  }
  settleOpenCalls();
  return lines;
}

function nativeBlock(part: SessionAssistantPart, arm: ThinkingRebuildArm): NativeEntry | null {
  if (part.type === "text")
    return part.text !== undefined && part.text !== "" ? { type: "text", text: part.text } : null;
  if (part.type === "toolCall")
    return { type: "tool_use", id: part.toolCallId ?? "", name: part.toolName ?? "tool", input: part.arguments ?? {} };
  if (part.type === "redacted_thinking") return arm === "omit" ? null : (part.block ?? null);
  if (part.type === "thinking") {
    if (arm === "omit") return null;
    const signature =
      typeof part.thinkingSignature === "string" && part.thinkingSignature !== "" ? part.thinkingSignature : undefined;
    return signature === undefined ? null : { type: "thinking", thinking: part.thinking ?? "", signature };
  }
  return part.block ?? null;
}

export function isMessageEntry(entry: SessionThreadViewEntry): boolean {
  return "role" in entry;
}
