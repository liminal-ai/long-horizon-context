import { createHash } from "node:crypto";

import type { MessageEventInput } from "lhc";
import type { RolloutLineItem } from "../rollout/types.js";
import { mapRolloutLine } from "./map.js";

export const MAX_THREAD_SIGNATURES = 500;

export interface ReplayDedupeState {
  /** Replay-prefix skip window; cleared permanently on first novel event. */
  replayWindowActive: boolean;
  seen: Set<string>;
}

export function createReplayDedupeState(
  replayWindowActive: boolean,
  existingSignatures: readonly string[] = [],
): ReplayDedupeState {
  return { replayWindowActive, seen: new Set(existingSignatures) };
}

function stablePayloadString(payload: MessageEventInput["payload"]): string {
  if (typeof payload === "object" && payload !== null && "text" in payload && typeof payload.text === "string") {
    return payload.text.replace(/\s+/g, " ").trim();
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/** sha256(kind + normalized payload) for one mapped intake event. */
export function eventContentSignature(event: MessageEventInput): string {
  const normalized = `${event.eventKind}|${stablePayloadString(event.payload)}`;
  return createHash("sha256").update(normalized).digest("hex");
}

export function signaturesForRolloutLine(item: RolloutLineItem, lineIndex: number): string[] {
  const mapped = mapRolloutLine(item, lineIndex);
  return mapped.events.map((event) => eventContentSignature(event));
}

export interface ReplayFilterResult {
  toSend: MessageEventInput[];
  skipped: number;
  signaturesToAdd: string[];
}

export function filterReplayEvents(events: readonly MessageEventInput[], state: ReplayDedupeState): ReplayFilterResult {
  const toSend: MessageEventInput[] = [];
  const signaturesToAdd: string[] = [];
  let skipped = 0;

  for (const event of events) {
    const signature = eventContentSignature(event);
    if (state.replayWindowActive && state.seen.has(signature)) {
      skipped += 1;
      continue;
    }
    if (state.replayWindowActive) {
      state.replayWindowActive = false;
    }
    toSend.push(event);
    signaturesToAdd.push(signature);
  }

  return { toSend, skipped, signaturesToAdd };
}

export function trimSignatures(signatures: readonly string[], max = MAX_THREAD_SIGNATURES): string[] {
  if (signatures.length <= max) return [...signatures];
  return signatures.slice(signatures.length - max);
}

export function mergeSignatures(
  existing: readonly string[],
  added: readonly string[],
  max = MAX_THREAD_SIGNATURES,
): string[] {
  const merged = [...existing];
  for (const signature of added) {
    if (!merged.includes(signature)) merged.push(signature);
  }
  return trimSignatures(merged, max);
}
