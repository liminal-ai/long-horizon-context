import type { OpResult } from "../shared-tech/index.js";
import type { WorkKind, WorkOwner, WorkSourceRef } from "../shared-tech/work-queue/index.js";
import type { ThreadRef } from "../threads/index.js";
import { runListEvents, runMessageEvents } from "./internal/pipeline.js";

interface BaseEvent<K extends string, P> {
  eventKind: K;
  idempotencyKey: string;
  actor: string; // non-empty
  harness: string; // non-empty
  payload: P; // shape fixed by kind, closed
}

// Host-observed turn outcome/timing on turn_end (schema v5 / D1). All optional;
// empty payload stays valid for hosts that do not report these facts.
export type TurnEndPayload = {
  outcome?: "completed" | "aborted";
  outcomeReason?: string;
  startedAt?: string;
  endedAt?: string;
};

// Host-supplied step index (schema v12, turn parts F2): the zero-based
// provider request/response cycle inside the turn that this message belongs
// to. Optional; NULL in storage when omitted. A tool_result carries the same
// index as its tool_call. LHC records it verbatim and never infers it.
export type StepScoped = {
  stepIndex?: number;
};

// Host-reported model identity for one assistant message fan-out. Needed so a
// resumed PI session can re-stamp provider/api/model and keep signed thinking
// through PI's same-model check (transform-messages). Opaque strings.
export type AssistantModelProvenance = {
  provider?: string;
  model?: string;
  api?: string;
};

// Provider usage is the host's verbatim JSON object for one model call — no
// fixed column set, no interpretation inside LHC (schema v5 / D1, D3).
export type AssistantTextPayload = {
  text: string;
  providerUsage?: Record<string, unknown>;
} & AssistantModelProvenance &
  StepScoped;

// Optional signature is an opaque provider token (Anthropic encrypted
// thinking, OpenAI reasoning item id, etc.). LHC stores and returns it
// verbatim — no interpretation (same posture as providerUsage).
export type AssistantThinkingPayload = {
  text: string;
  signature?: string;
} & AssistantModelProvenance &
  StepScoped;

/**
 * Typed compact-continuation marker payload (LIM-61).
 * Model-visible when served; LHC inspect/retrieval-visible; hidden from ordinary user chat.
 * Semantics fields are frozen by the compact-continuation contract.
 */
export type CompactContinuationMarkerPayload = {
  kind: "lhc.compact_continuation";
  continuationTurnId: string;
  cause: "context_compacted_task_in_progress";
  action: "continue_existing_task";
  newUserRequest: false;
  waitForUser: false;
};

export type MessageEventInput =
  | BaseEvent<"user_prompt", { text: string }>
  | BaseEvent<"assistant_text", AssistantTextPayload>
  | BaseEvent<"assistant_thinking", AssistantThinkingPayload>
  | BaseEvent<"runtime_note", { text: string }>
  | BaseEvent<"model_change", { previousModel: string; newModel: string }>
  | BaseEvent<"thinking_level_change", { previousLevel: string; newLevel: string }>
  | BaseEvent<"tool_call", { toolCallId: string; toolName: string; arguments: Record<string, unknown> } & StepScoped>
  | BaseEvent<"tool_result", { toolCallId: string; content: string; isError?: boolean } & StepScoped>
  | BaseEvent<"compact_continuation_marker", CompactContinuationMarkerPayload>
  | BaseEvent<"turn_end", TurnEndPayload>;

// Derived, not parallel-maintained: the kind list cannot drift from the union.
export type EventKind = MessageEventInput["eventKind"];

export interface BatchResult {
  events: Array<{
    idempotencyKey: string;
    outcome: "recorded" | "skipped";
    messageId?: string;
    skipReason?: "duplicate_idempotency_key";
  }>;
  turnTransitions: Array<{ action: "opened" | "closed"; turnId: string }>;
  queuedWork: Array<{
    workItemId: string;
    owner: WorkOwner;
    kind: WorkKind;
    sourceRef: WorkSourceRef;
  }>;
  threadPosition: { lastEventOrder: number };
}

// Read-back preserves the discrimination: intersecting the input union with
// server fields distributes over its members, so a narrowed eventKind narrows
// the payload on read exactly as it does on write.
export type EventRecord = MessageEventInput & {
  eventOrder: number;
  recordedAt: string;
};

export async function messageEvents(
  threadRef: ThreadRef,
  events: readonly MessageEventInput[],
): Promise<OpResult<BatchResult>> {
  return runMessageEvents(threadRef, events);
}

export async function listEvents(threadRef: ThreadRef): Promise<OpResult<EventRecord[]>> {
  return runListEvents(threadRef);
}
