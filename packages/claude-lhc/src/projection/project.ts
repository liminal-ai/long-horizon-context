import { randomUUID } from "node:crypto";
import type {
  SessionAssistantMessage,
  SessionAssistantPart,
  SessionThreadView,
  SessionThreadViewEntry,
  SessionThreadViewMessage,
} from "lhc";
import { HARNESS } from "../capture/mapper.js";

export interface ProjectionStamp {
  sessionId: string;
  cwd: string;
  version: string;
  permissionMode: string;
  model: string;
  gitBranch?: string;
}

export type NativeEntry = Record<string, unknown>;

export const PROJECTED_SOURCE_FIELD = "lhcSource";
export const FALLBACK_CLAUDE_CODE_VERSION = "2.1.259";
export const FALLBACK_PROJECTION_MODEL = "claude-sonnet-5";

export type ThinkingRebuildArm = "signed_verbatim" | "omit";
export const SELECTED_THINKING_REBUILD_ARM: ThinkingRebuildArm = "signed_verbatim";

const DANGLING_RESULT = "[tool result unavailable: the session was interrupted before this call completed]";
const SUMMARY_BAND = /^\[context · [a-z]+\]\n/;

export interface ProjectedAttachment {
  readonly uuid: string;
  readonly line: NativeEntry;
}

export type AttachmentsByAnchor = ReadonlyMap<string, readonly ProjectedAttachment[]>;

export interface ProjectionOptions {
  readonly arm?: ThinkingRebuildArm;
  readonly attachments?: AttachmentsByAnchor;
}

export function anchorOf(key: string): string | null {
  const harness = `${HARNESS}:`;
  const end = key.startsWith(harness) ? key.indexOf(":", harness.length) : -1;
  return end === -1 ? null : key.slice(0, end + 1);
}

export function projectView(
  view: SessionThreadView,
  stamp: ProjectionStamp,
  { arm = SELECTED_THINKING_REBUILD_ARM, attachments = new Map() }: ProjectionOptions = {},
): NativeEntry[] {
  const now = new Date().toISOString();
  const lines: NativeEntry[] = [];
  let parent: string | null = null;
  let model = stamp.model;
  const openCalls = new Set<string>();
  const lastHolder = lastFullFidelityHolders(view.entries, attachments);

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
  const push = (line: NativeEntry, source: string | null): void => {
    const uuid = randomUUID();
    lines.push({ ...line, ...(source === null ? {} : { [PROJECTED_SOURCE_FIELD]: source }), uuid });
    parent = uuid;
  };
  const userText = (content: string | NativeEntry[], source: string | null): void =>
    push(
      {
        ...base(),
        type: "user",
        message: { role: "user", content },
        permissionMode: stamp.permissionMode,
        promptSource: "sdk",
      },
      source,
    );
  const toolResult = (
    toolCallId: string,
    content: string | NativeEntry[],
    isError: boolean,
    source: string | null,
  ): void => {
    openCalls.delete(toolCallId);
    push(
      {
        ...base(),
        type: "user",
        message: {
          role: "user",
          content: [{ tool_use_id: toolCallId, type: "tool_result", content, is_error: isError }],
        },
      },
      source,
    );
  };
  const settleOpenCalls = (): void => {
    for (const id of [...openCalls]) toolResult(id, DANGLING_RESULT, true, null);
  };

  const assistant = (entry: SessionAssistantMessage, source: string | null): void => {
    const aligned = entry.sourceMessages.length === entry.content.length;
    const blocks = entry.content
      .map((part, i) => ({
        block: nativeBlock(part, arm),
        source: aligned ? (entry.sourceMessages[i]?.idempotencyKey ?? null) : source,
      }))
      .filter((b): b is { block: NativeEntry; source: string | null } => b.block !== null);
    if (blocks.length === 0) return;
    const stop = blocks.some(({ block }) => block["type"] === "tool_use") ? "tool_use" : "end_turn";
    const id = `msg_${randomUUID().replace(/-/g, "")}`;
    const requestId = `req_${randomUUID().replace(/-/g, "")}`;
    for (const [index, { block, source: blockSource }] of blocks.entries()) {
      if (block["type"] === "tool_use") openCalls.add(String(block["id"]));
      push(
        {
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
        },
        blockSource,
      );
    }
  };

  for (const [index, entry] of view.entries.entries()) {
    if (!("role" in entry)) {
      if (entry.kind === "model_change" && entry.modelId !== "") model = entry.modelId;
      continue;
    }
    const source = sourceKey(entry);
    if (entry.role === "user") {
      settleOpenCalls();
      userText(entry.blocks ?? entry.content, source);
    } else if (entry.role === "toolResult") {
      toolResult(entry.toolCallId, entry.blocks ?? entry.content, entry.isError === true, source);
    } else {
      settleOpenCalls();
      assistant(entry, source);
    }
    for (const anchor of anchorsOf(entry)) {
      if (lastHolder.get(anchor) !== index) continue;
      for (const { uuid, line } of attachments.get(anchor) ?? []) push({ ...base(), ...line }, `attachment:${uuid}`);
    }
  }
  settleOpenCalls();
  return lines;
}

function sourceKey(entry: SessionThreadViewMessage): string | null {
  return entry.sourceMessages.at(-1)?.idempotencyKey ?? null;
}

function anchorsOf(entry: SessionThreadViewMessage): Set<string> {
  const anchors = new Set<string>();
  for (const { idempotencyKey } of entry.sourceMessages) {
    const anchor = idempotencyKey === null ? null : anchorOf(idempotencyKey);
    if (anchor !== null) anchors.add(anchor);
  }
  return anchors;
}

// The served view opens with its summary bands. A message a band covers is not projected, so neither are
// its attachments. Every other anchor's attachments follow the last entry that holds it.
function lastFullFidelityHolders(
  entries: readonly SessionThreadViewEntry[],
  attachments: AttachmentsByAnchor,
): Map<string, number> {
  const holders = new Map<string, number>();
  if (attachments.size === 0) return holders;
  let band = true;
  for (const [index, entry] of entries.entries()) {
    band &&= "role" in entry && entry.role === "user" && SUMMARY_BAND.test(entry.content);
    if (band || !("role" in entry)) continue;
    for (const anchor of anchorsOf(entry)) if (attachments.has(anchor)) holders.set(anchor, index);
  }
  return holders;
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
