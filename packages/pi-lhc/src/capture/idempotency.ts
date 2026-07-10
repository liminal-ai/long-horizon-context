import { createHash } from "node:crypto";
import type { EventKind } from "lhc";

// Stable per-event key so re-delivery dedups and crash-replay is safe. Pure,
// deterministic: identical across re-delivery of the same logical event,
// distinct across different events. Construction precedence: PI entry id, else
// provider responseId/toolCallId, else a content fingerprint as last resort.
// `blockIndex` and `kind` ride every tier so one message's fan-out stays
// distinct under a single shared id.

export interface EventKeyInput {
  piSessionId: string;
  // Optionals admit explicit `undefined` so a caller can thread a
  // possibly-absent id through directly under exactOptionalPropertyTypes.
  entryId?: string | undefined;
  responseId?: string | undefined;
  toolCallId?: string | undefined;
  blockIndex: number;
  kind: EventKind;
  role?: string | undefined;
  fallbackId?: string | undefined;
  content?: string | undefined;
}

// Join fingerprint parts with the ASCII unit separator — a delimiter that
// effectively never occurs in PI message text, so two different part lists
// cannot collide into the same joined string.
const SEP = "\u001f";

/** A short, stable content fingerprint — the last-resort key tier when an
 *  event carries no PI/provider id. sha256 truncated: collision-resistant
 *  enough for dedup, short enough to keep keys readable. */
export function fingerprint(...parts: string[]): string {
  return createHash("sha256").update(parts.join(SEP)).digest("hex").slice(0, 24);
}

export function eventKey(input: EventKeyInput): string {
  const { piSessionId, entryId, responseId, toolCallId, blockIndex, kind } = input;
  // Tier 1 — PI entry id: the most stable identity, present on real
  // finalized message; disambiguated by block + kind for the fan-out.
  if (entryId !== undefined && entryId !== "") {
    return `pi:${piSessionId}:entry:${encodeURIComponent(entryId)}:block:${blockIndex}:kind:${kind}`;
  }
  // Tier 2 — tool-call id: stable across re-delivery and independent of arrival
  // order; kind separates the call from its result under the same id.
  if (toolCallId !== undefined && toolCallId !== "") {
    return `pi:${piSessionId}:tool:${encodeURIComponent(toolCallId)}:kind:${kind}`;
  }
  // Tier 3 — provider response id: stable per assistant response.
  if (responseId !== undefined && responseId !== "") {
    return `pi:${piSessionId}:resp:${encodeURIComponent(responseId)}:block:${blockIndex}:kind:${kind}`;
  }
  // Tier 4 — content fingerprint: last resort for an event with no id at all.
  // Include any caller-supplied stable discriminator; content alone is never
  // enough to distinguish two separate same-text events.
  const role = input.role ?? "";
  const fallbackId = input.fallbackId ?? "no-stable-id";
  const fp = fingerprint(fallbackId, role, kind, input.content ?? "");
  return `pi:${piSessionId}:fp:${fallbackId}:${blockIndex}:${role}:${kind}:${fp}`;
}

export interface ParsedEventKeySource {
  entryId?: string;
  toolCallId?: string;
  responseId?: string;
  /** Present on entry- and response-tier keys. */
  blockIndex?: number;
  /** Event kind segment from the key (`tool_result`, `runtime_note`, …). */
  kind?: string;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseEventKeySource(key: string): ParsedEventKeySource | null {
  const entry = /^pi:.*:entry:([^:]+):block:(\d+):kind:([^:]+)$/.exec(key);
  if (entry?.[1] !== undefined && entry[2] !== undefined && entry[3] !== undefined) {
    const entryId = decode(entry[1]);
    return entryId === null ? null : { entryId, blockIndex: Number(entry[2]), kind: entry[3] };
  }

  const tool = /^pi:.*:tool:([^:]+):kind:([^:]+)$/.exec(key);
  if (tool?.[1] !== undefined && tool[2] !== undefined) {
    const toolCallId = decode(tool[1]);
    return toolCallId === null ? null : { toolCallId, kind: tool[2] };
  }

  const response = /^pi:.*:resp:([^:]+):block:(\d+):kind:([^:]+)$/.exec(key);
  if (response?.[1] !== undefined && response[2] !== undefined && response[3] !== undefined) {
    const responseId = decode(response[1]);
    return responseId === null ? null : { responseId, blockIndex: Number(response[2]), kind: response[3] };
  }

  return null;
}
