import type { AgentMessage as PiSessionMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  SessionModelChangeEntry,
  SessionThinkingLevelChangeEntry,
  SessionThreadViewEntry,
  SessionThreadViewEntrySource,
  SessionThreadViewMessage,
} from "lhc";
import { LHC_SEED_ENTRY_MAP_TYPE, type LhcSeedEntryMapRow } from "../compact/seed-entry-map.js";

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

function collectSeedRows(
  seedRows: LhcSeedEntryMapRow[],
  piEntryId: string,
  sourceMessages: readonly SessionThreadViewEntrySource[],
): void {
  for (const source of sourceMessages) {
    seedRows.push({ lhcMessageId: source.messageId, piEntryId });
  }
}

/** Append LHC session-thread-view entries to a PI SessionManager in record order. */
export function applySessionThreadViewToSessionManager(
  sessionManager: SessionManager,
  entries: readonly SessionThreadViewEntry[],
  threadId: string,
): { messageCount: number; seedEntryMapRows: LhcSeedEntryMapRow[] } {
  let messageCount = 0;
  const baseTimestamp = Date.now();
  let messageIndex = 0;
  const seedRows: LhcSeedEntryMapRow[] = [];

  for (const entry of entries) {
    if (isModelChangeEntry(entry)) {
      const piEntryId = sessionManager.appendModelChange(entry.provider, entry.modelId);
      collectSeedRows(seedRows, piEntryId, entry.sourceMessages);
      continue;
    }
    if (isThinkingLevelChangeEntry(entry)) {
      const piEntryId = sessionManager.appendThinkingLevelChange(entry.level);
      collectSeedRows(seedRows, piEntryId, entry.sourceMessages);
      continue;
    }
    if (!isMessageEntry(entry)) continue;
    const piEntryId = sessionManager.appendMessage(
      mapMessageToPiSession(entry, baseTimestamp + messageIndex) as Parameters<SessionManager["appendMessage"]>[0],
    );
    collectSeedRows(seedRows, piEntryId, entry.sourceMessages);
    messageIndex += 1;
    messageCount += 1;
  }

  if (seedRows.length > 0 && typeof sessionManager.appendCustomEntry === "function") {
    sessionManager.appendCustomEntry(LHC_SEED_ENTRY_MAP_TYPE, {
      customType: LHC_SEED_ENTRY_MAP_TYPE,
      threadId,
      entries: seedRows,
    } satisfies { customType: typeof LHC_SEED_ENTRY_MAP_TYPE; threadId: string; entries: LhcSeedEntryMapRow[] });
  }

  return { messageCount, seedEntryMapRows: seedRows };
}
