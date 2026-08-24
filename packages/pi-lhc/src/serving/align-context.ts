// Tail-cut alignment for the `context` hook (TC-7.2c). Pure.
//
// Pi's `context` event carries a deep copy of the agent's message list with no
// entry ids. The installed LHC view names its first kept message; capture
// keyed that message to a Pi session entry id. This module maps that entry id
// to the index in the event's message list where Pi's own objects for the
// verbatim tail begin, and refuses — so the caller serves the raw list — when
// the mapping cannot be verified.
//
// Primary rule: Pi builds the list from its compaction-aware context entries,
// one entry at a time, in order (session-manager buildSessionContext). Every
// `message` entry contributes exactly one message (bashExecution included —
// `!!` exclusion happens later, at convertToLlm), a `compaction` entry
// contributes its summary plus any retained tail, `branch_summary` and
// `custom_message` one each; `custom`, model/thinking changes, labels, and
// session info contribute none. The target index is the count of messages the
// entries before the target contribute. The primary rule is verified at both
// ends: the message at the index and the last message must match their
// entries by role, timestamp, and tool-call id, and the counts must agree.
//
// Fallback: when counts disagree (an entry Pi did not materialize, or a
// message with no entry), the target is located by identity — role,
// timestamp, tool-call id — and accepted only when exactly one message
// matches. Anything else is a failed alignment.
import type { AgentMessage, SessionEntry } from "../pi/types.js";

export type TailAlignment = { ok: true; index: number; via: "count" | "identity" } | { ok: false; reason: string };

export interface TailAlignmentInput {
  /** Pi entry id of the first kept message (the first message of step k+1). */
  firstKeptEntryId: string;
  /** Pi's compaction-aware context entries, in order (SessionManager.buildContextEntries). */
  contextEntries: readonly SessionEntry[];
  /** The `context` event's message list. */
  messages: readonly AgentMessage[];
}

function messageCountOf(entry: SessionEntry): number {
  switch (entry.type) {
    case "message":
      return entry.message === undefined ? 0 : 1;
    case "compaction": {
      const tail = (entry as { retainedTail?: unknown }).retainedTail;
      return 1 + (Array.isArray(tail) ? tail.length : 0);
    }
    case "branch_summary":
    case "custom_message":
      return 1;
    default:
      return 0;
  }
}

interface Identity {
  role: string;
  timestamp: number | null;
  toolCallId: string | null;
}

function identityOfMessage(message: AgentMessage | undefined): Identity | null {
  if (message === undefined) return null;
  const record = message as unknown as Record<string, unknown>;
  const timestamp = record["timestamp"];
  const toolCallId = record["toolCallId"];
  return {
    role: message.role,
    timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null,
    toolCallId: typeof toolCallId === "string" ? toolCallId : null,
  };
}

function identityOfEntry(entry: SessionEntry): Identity | null {
  if (entry.type === "message") return identityOfMessage(entry.message);
  // Entries Pi materializes without a stored message object (compaction,
  // branch summary, custom message) carry their own role and timestamp.
  const role =
    entry.type === "compaction" ? "compactionSummary" : entry.type === "branch_summary" ? "branchSummary" : "custom";
  const stamp = (entry as { timestamp?: unknown }).timestamp;
  const timestamp = typeof stamp === "number" ? stamp : typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return { role, timestamp: Number.isFinite(timestamp) ? timestamp : null, toolCallId: null };
}

function sameIdentity(entry: Identity | null, message: Identity | null): boolean {
  if (entry === null || message === null) return false;
  if (entry.role !== message.role) return false;
  if (entry.timestamp === null || message.timestamp === null || entry.timestamp !== message.timestamp) return false;
  return entry.toolCallId === message.toolCallId;
}

export function alignTailStart(input: TailAlignmentInput): TailAlignment {
  const { firstKeptEntryId, contextEntries, messages } = input;
  const targetIndex = contextEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (targetIndex < 0) {
    return { ok: false, reason: `first kept entry ${firstKeptEntryId} is not in Pi's context entries` };
  }
  const target = contextEntries[targetIndex] as SessionEntry;
  if (messageCountOf(target) === 0) {
    return { ok: false, reason: `first kept entry ${firstKeptEntryId} contributes no context message` };
  }
  const targetIdentity = identityOfEntry(target);
  if (targetIdentity === null || targetIdentity.timestamp === null) {
    return { ok: false, reason: `first kept entry ${firstKeptEntryId} has no verifiable identity` };
  }

  // Primary: count the messages the entries before the target contribute,
  // then verify both ends of the tail.
  let before = 0;
  for (let i = 0; i < targetIndex; i += 1) before += messageCountOf(contextEntries[i] as SessionEntry);
  let fromTarget = 0;
  for (let i = targetIndex; i < contextEntries.length; i += 1) {
    fromTarget += messageCountOf(contextEntries[i] as SessionEntry);
  }
  const lastEntry = [...contextEntries].reverse().find((entry) => messageCountOf(entry) > 0);
  const countsAgree = before + fromTarget === messages.length;
  const headMatches = sameIdentity(targetIdentity, identityOfMessage(messages[before]));
  const tailMatches =
    lastEntry === undefined ||
    messageCountOf(lastEntry) !== 1 ||
    sameIdentity(identityOfEntry(lastEntry), identityOfMessage(messages[messages.length - 1]));
  if (countsAgree && headMatches && tailMatches) return { ok: true, index: before, via: "count" };

  // Fallback: identity must be unique in the list.
  const candidates: number[] = [];
  messages.forEach((message, index) => {
    if (sameIdentity(targetIdentity, identityOfMessage(message))) candidates.push(index);
  });
  if (candidates.length === 1) return { ok: true, index: candidates[0] as number, via: "identity" };
  return {
    ok: false,
    reason:
      candidates.length === 0
        ? `no message matches first kept entry ${firstKeptEntryId} (role ${targetIdentity.role}, timestamp ${targetIdentity.timestamp})`
        : `${candidates.length} messages match first kept entry ${firstKeptEntryId}; counts disagree (${before + fromTarget} from entries, ${messages.length} in the event)`,
  };
}
