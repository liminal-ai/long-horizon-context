import type { AgentMessage as PiSessionMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  LlmRequestContextMessage,
  SessionModelChangeEntry,
  SessionThinkingLevelChangeEntry,
  SessionThreadViewEntry,
  SessionThreadViewMessage,
} from "lhc";

/** One bounded message line in the last-serve diagnostic preview. */
export interface ContextServeMessagePreview {
  role: "user" | "assistant";
  textPreview: string;
}

export const CONTEXT_SERVE_PREVIEW_MAX_MESSAGES = 8;
export const CONTEXT_SERVE_PREVIEW_MAX_TEXT = 120;

function truncatePreviewText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function llmMessageText(message: LlmRequestContextMessage): string {
  return message.content.map((part) => part.text).join("");
}

/** Build a bounded, deterministic preview of served LHC messages for diagnostics. */
export function buildContextServePreview(messages: readonly LlmRequestContextMessage[]): {
  preview: ContextServeMessagePreview[];
  previewWindow?: "first" | "last";
} {
  const max = CONTEXT_SERVE_PREVIEW_MAX_MESSAGES;
  const useLast = messages.length > max;
  const selected = useLast ? messages.slice(-max) : messages;
  const preview = selected.map((message) => ({
    role: message.role,
    textPreview: truncatePreviewText(llmMessageText(message), CONTEXT_SERVE_PREVIEW_MAX_TEXT),
  }));
  return useLast ? { preview, previewWindow: "last" } : { preview };
}

function isMessageEntry(entry: SessionThreadViewEntry): entry is SessionThreadViewMessage {
  return "role" in entry;
}

function isModelChangeEntry(entry: SessionThreadViewEntry): entry is SessionModelChangeEntry {
  return "kind" in entry && entry.kind === "model_change";
}

function isThinkingLevelChangeEntry(entry: SessionThreadViewEntry): entry is SessionThinkingLevelChangeEntry {
  return "kind" in entry && entry.kind === "thinking_level_change";
}

function mapMessageToPiSession(message: SessionThreadViewMessage, timestamp: number): PiSessionMessage {
  if (message.role === "user") {
    return { role: "user", content: message.content, timestamp };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName ?? "unknown_tool",
      content: [{ type: "text", text: message.content }],
      isError: message.isError === true,
      timestamp,
    };
  }
  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type === "thinking") {
        return { type: "thinking" as const, thinking: part.thinking ?? "" };
      }
      if (part.type === "toolCall") {
        return {
          type: "toolCall" as const,
          id: part.toolCallId ?? "",
          name: part.toolName ?? "",
          arguments: part.arguments ?? {},
        };
      }
      return { type: "text" as const, text: part.text ?? "" };
    }),
    api: "openai-responses",
    provider: "lhc",
    model: "thread-view",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

/** Append LHC session-thread-view entries to a PI SessionManager in record order. */
export function applySessionThreadViewToSessionManager(
  sessionManager: SessionManager,
  entries: readonly SessionThreadViewEntry[],
): { messageCount: number } {
  let messageCount = 0;
  const baseTimestamp = Date.now();
  let messageIndex = 0;

  for (const entry of entries) {
    if (isModelChangeEntry(entry)) {
      sessionManager.appendModelChange(entry.provider, entry.modelId);
      continue;
    }
    if (isThinkingLevelChangeEntry(entry)) {
      sessionManager.appendThinkingLevelChange(entry.level);
      continue;
    }
    if (!isMessageEntry(entry)) continue;
    sessionManager.appendMessage(
      mapMessageToPiSession(entry, baseTimestamp + messageIndex) as Parameters<SessionManager["appendMessage"]>[0],
    );
    messageIndex += 1;
    messageCount += 1;
  }

  return { messageCount };
}
