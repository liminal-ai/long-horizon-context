import type { EventKind } from "lhc";
import { NotImplementedError } from "../shared/not-implemented.js";

// AC-2.6: a stable per-event key so re-delivery dedups and crash-replay is
// safe. Pure, deterministic — identical across re-delivery of the same logical
// event, distinct across different events. Construction precedence (Story 2):
// PI entry id, else provider responseId / toolCallId, else role:timestamp:hash.

export function eventKey(input: {
  piSessionId: string;
  entryId?: string;
  responseId?: string;
  toolCallId?: string;
  blockIndex: number;
  kind: EventKind;
  role?: string;
  timestamp?: number;
  content?: string;
}): string {
  throw new NotImplementedError("capture.eventKey");
}
