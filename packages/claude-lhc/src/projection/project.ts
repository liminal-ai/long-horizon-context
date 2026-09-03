/**
 * LHC served view → one fresh native Claude Code transcript generation.
 *
 * Shapes verified against Claude Code 2.1.259 transcripts written through SDK
 * 0.3.170 (scripts/spikes/01). Rules (cc-lhc rebuild + claude-lhc projector): band
 * context and runtime notes as plain user lines; the tail as native blocks — one
 * assistant line per block sharing a synthetic message id, tool results paired by
 * tool_use_id; thinking omitted (cc-lhc's certified arm — never an invented
 * signature); model_change stamps later assistant lines; thinking_level_change has
 * no native shape. A tool call the record never answered gets a synthetic error
 * result so the resumed transcript never ends on a dangling tool_use.
 */
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

const DANGLING_RESULT = "[tool result unavailable: the session was interrupted before this call completed]";

export function projectView(view: SessionThreadView, stamp: ProjectionStamp): NativeEntry[] {
  const now = new Date().toISOString();
  const lines: NativeEntry[] = [];
  let parent: string | null = null;
  let model = stamp.model;
  const openCalls = new Map<string, true>();

  const base = (): NativeEntry => ({
    parentUuid: parent, isSidechain: false, userType: "external", entrypoint: "sdk-ts",
    cwd: stamp.cwd, sessionId: stamp.sessionId, version: stamp.version, gitBranch: stamp.gitBranch ?? "",
    timestamp: now,
  });
  const push = (line: NativeEntry): void => {
    const uuid = randomUUID();
    lines.push({ ...line, uuid });
    parent = uuid;
  };
  const userText = (content: string): void =>
    push({ ...base(), type: "user", message: { role: "user", content }, permissionMode: stamp.permissionMode, promptSource: "sdk" });
  const toolResult = (toolCallId: string, content: string, isError: boolean): void => {
    openCalls.delete(toolCallId);
    push({ ...base(), type: "user", message: { role: "user", content: [{ tool_use_id: toolCallId, type: "tool_result", content, is_error: isError }] } });
  };
  const settleOpenCalls = (): void => {
    for (const id of [...openCalls.keys()]) toolResult(id, DANGLING_RESULT, true);
  };

  for (const entry of view.entries) {
    if (!("role" in entry)) {
      if (entry.kind === "model_change" && entry.modelId !== "") model = entry.modelId;
      continue;
    }
    if (entry.role === "user") { settleOpenCalls(); userText(entry.content); continue; }
    if (entry.role === "toolResult") { toolResult(entry.toolCallId, entry.content, entry.isError === true); continue; }
    settleOpenCalls();
    const blocks = entry.content.map(nativeBlock).filter((b): b is NativeEntry => b !== null);
    if (blocks.length === 0) continue;
    const stop = blocks.some((b) => b["type"] === "tool_use") ? "tool_use" : "end_turn";
    const id = `msg_${randomUUID().replace(/-/g, "")}`;
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    for (const [index, block] of blocks.entries()) {
      if (block["type"] === "tool_use") openCalls.set(String(block["id"]), true);
      push({
        ...base(), type: "assistant", apiBlockIndex: index, requestId,
        message: { model: entry.model ?? model, id, type: "message", role: "assistant", content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
    }
  }
  settleOpenCalls();
  return lines;
}

function nativeBlock(part: SessionAssistantPart): NativeEntry | null {
  if (part.type === "text") return part.text !== undefined && part.text !== "" ? { type: "text", text: part.text } : null;
  if (part.type === "toolCall") return { type: "tool_use", id: part.toolCallId ?? "", name: part.toolName ?? "tool", input: part.arguments ?? {} };
  return null; // thinking: omitted
}

export function isMessageEntry(entry: SessionThreadViewEntry): boolean {
  return "role" in entry;
}
