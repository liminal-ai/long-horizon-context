import type {
  SessionThreadViewEntry,
  SessionThreadViewEntrySource,
  SessionToolResultMessage,
  SessionUserMessage,
} from "lhc";
import { parseEventKeySource } from "../capture/idempotency.js";

// PI capture fans one toolResult message into tool_result (block 0) plus one
// runtime_note per unsupported part (block 1+), all sharing the same PI entry
// identity. SessionThreadView currently emits each runtime_note as an
// independent labeled user entry, which splits Anthropic's required atomic
// tool-result batch on rehydrate. This pass folds only structurally associated
// omission notes back into the tool result they annotate — PI reconstruction
// only; the durable record is unchanged.

const SESSION_RUNTIME_NOTE_PREFIX = "[runtime note] ";
const OMISSION_CONTENT_LABEL = "[tool-result omission]";

function isUserMessage(entry: SessionThreadViewEntry): entry is SessionUserMessage {
  return "role" in entry && entry.role === "user";
}

function isToolResultMessage(entry: SessionThreadViewEntry): entry is SessionToolResultMessage {
  return "role" in entry && entry.role === "toolResult";
}

function primarySourceKey(sources: readonly SessionThreadViewEntrySource[]): string | null {
  const key = sources[0]?.idempotencyKey;
  return typeof key === "string" && key !== "" ? key : null;
}

/** True when `noteToolCallId` is the capture-side synthetic sibling
 *  `${resultToolCallId}:omission:<n>` used when no PI entry id is available. */
function isToolTierOmissionId(resultToolCallId: string, noteToolCallId: string): boolean {
  const prefix = `${resultToolCallId}:omission:`;
  if (!noteToolCallId.startsWith(prefix)) return false;
  return /^\d+$/.test(noteToolCallId.slice(prefix.length));
}

/**
 * Structural association: a runtime_note is a tool-result omission sibling iff
 * its PI idempotency key shares identity with the tool_result it follows —
 * either the same PI entry id with a higher block index (primary / historical),
 * or the tool-tier `:omission:<n>` toolCallId suffix (fallback when entry id
 * was unavailable at capture). Never English-text matching.
 */
export function isToolResultOmissionNote(toolResult: SessionToolResultMessage, candidate: SessionUserMessage): boolean {
  const resultKey = primarySourceKey(toolResult.sourceMessages);
  const noteKey = primarySourceKey(candidate.sourceMessages);
  if (resultKey === null || noteKey === null) return false;

  const result = parseEventKeySource(resultKey);
  const note = parseEventKeySource(noteKey);
  if (result === null || note === null) return false;
  if (result.kind !== "tool_result" || note.kind !== "runtime_note") return false;

  if (result.entryId !== undefined && note.entryId !== undefined) {
    if (result.entryId !== note.entryId) return false;
    if (result.blockIndex === undefined || note.blockIndex === undefined) return false;
    return note.blockIndex > result.blockIndex;
  }

  if (result.toolCallId !== undefined && note.toolCallId !== undefined) {
    return isToolTierOmissionId(result.toolCallId, note.toolCallId);
  }

  return false;
}

function omissionBody(content: string): string {
  return content.startsWith(SESSION_RUNTIME_NOTE_PREFIX) ? content.slice(SESSION_RUNTIME_NOTE_PREFIX.length) : content;
}

function appendOmissionNote(content: string, noteText: string): string {
  const labeled = `${OMISSION_CONTENT_LABEL}\n${noteText}`;
  return content.length === 0 ? labeled : `${content}\n\n${labeled}`;
}

/**
 * Fold consecutive structurally associated tool-result omission runtime notes
 * into the preceding tool result's content so parallel results stay consecutive
 * PI toolResult messages. Unrelated runtime notes remain independent user entries.
 */
export function foldToolResultOmissionNotes(entries: readonly SessionThreadViewEntry[]): SessionThreadViewEntry[] {
  const out: SessionThreadViewEntry[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (!isToolResultMessage(entry)) {
      out.push(entry);
      continue;
    }

    let content = entry.content;
    const sourceMessages: SessionThreadViewEntrySource[] = [...entry.sourceMessages];
    let j = i + 1;
    while (j < entries.length) {
      const next = entries[j]!;
      if (!isUserMessage(next) || !isToolResultOmissionNote(entry, next)) break;
      content = appendOmissionNote(content, omissionBody(next.content));
      sourceMessages.push(...next.sourceMessages);
      j += 1;
    }

    if (j === i + 1) {
      out.push(entry);
      continue;
    }

    const folded: SessionToolResultMessage = {
      role: "toolResult",
      toolCallId: entry.toolCallId,
      content,
      sourceMessages,
    };
    if (entry.toolName !== undefined) folded.toolName = entry.toolName;
    if (entry.isError === true) folded.isError = true;
    out.push(folded);
    i = j - 1;
  }

  return out;
}
