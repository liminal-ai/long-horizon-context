import { createHash } from "node:crypto";
import type { EventKind } from "lhc";

// AC-2.6: a stable per-event key so re-delivery dedups and crash-replay is
// safe. Pure, deterministic — identical across re-delivery of the same logical
// event, distinct across different events. Construction precedence (from the
// POC mapper, carried forward): PI entry id, else provider responseId /
// toolCallId, else a content fingerprint as last resort. `blockIndex` and
// `kind` ride every tier so one message's fan-out (thinking → text →
// tool_call×N) stays distinct under a single shared id.

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
    return `pi:${piSessionId}:${entryId}:${blockIndex}:${kind}`;
  }
  // Tier 2 — tool-call id: stable across re-delivery and independent of arrival
  // order; kind separates the call from its result under the same id.
  if (toolCallId !== undefined && toolCallId !== "") {
    return `pi:${piSessionId}:tool:${toolCallId}:${kind}`;
  }
  // Tier 3 — provider response id: stable per assistant response.
  if (responseId !== undefined && responseId !== "") {
    return `pi:${piSessionId}:resp:${responseId}:${blockIndex}:${kind}`;
  }
  // Tier 4 — content fingerprint: last resort for an event with no id at all.
  // Include any caller-supplied stable discriminator; content alone is never
  // enough to distinguish two separate same-text events.
  const role = input.role ?? "";
  const fallbackId = input.fallbackId ?? "no-stable-id";
  const fp = fingerprint(fallbackId, role, kind, input.content ?? "");
  return `pi:${piSessionId}:fp:${fallbackId}:${blockIndex}:${role}:${kind}:${fp}`;
}
