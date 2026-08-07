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
import { foldToolResultOmissionNotes } from "./fold-tool-result-omissions.js";

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
  // Prefer host-captured identity so PI's same-model check keeps thinking
  // signatures on the live provider path. Fall back only for pre-provenance rows.
  const provider = typeof message.provider === "string" && message.provider !== "" ? message.provider : "lhc";
  const model = typeof message.model === "string" && message.model !== "" ? message.model : "thread-view";
  const api = typeof message.api === "string" && message.api !== "" ? message.api : ("openai-responses" as const);

  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type === "thinking") {
        const thinking: { type: "thinking"; thinking: string; thinkingSignature?: string } = {
          type: "thinking",
          thinking: part.thinking ?? "",
        };
        if (part.thinkingSignature !== undefined && part.thinkingSignature !== "") {
          thinking.thinkingSignature = part.thinkingSignature;
        }
        return thinking;
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
    api,
    provider,
    model,
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

  // Fold PI tool-result omission runtime_notes into their sibling tool results
  // so parallel results remain consecutive (Anthropic tool protocol).
  const reconstructed = foldToolResultOmissionNotes(entries);

  for (const entry of reconstructed) {
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
