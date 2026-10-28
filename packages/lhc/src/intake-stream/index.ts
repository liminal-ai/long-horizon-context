import type { ApiBlock, OpResult } from "../shared-tech/index.js";
import type { WorkKind, WorkOwner, WorkSourceRef } from "../shared-tech/work-queue/index.js";
import type { ThreadRef } from "../threads/index.js";
import {
  type EventKeyPageOptions,
  type EventKeyPageResult,
  type EventKeyPrefixCountRow,
  type EventKeyRef,
  runEventKeyPrefixCounts,
  runListEventKeysByPrefix,
  runListEvents,
  runMessageEvents,
  runThreadFrontier,
  type ThreadFrontierRow,
} from "./internal/pipeline.js";

export { LEGACY_KEY_PAGE_LIMIT, LEGACY_KEY_TOTAL_LOOKUP_CAP } from "./internal/pipeline.js";

interface BaseEvent<K extends string, P> {
  eventKind: K;
  idempotencyKey: string;
  actor: string;
  harness: string;
  payload: P;
}

export type TurnEndPayload = {
  outcome?: "completed" | "aborted";
  outcomeReason?: string;
  startedAt?: string;
  endedAt?: string;
};

export type StepScoped = {
  stepIndex?: number;
};

export type AssistantModelProvenance = {
  provider?: string;
  model?: string;
  api?: string;
};

export type AssistantTextPayload = {
  text: string;
  providerUsage?: Record<string, unknown>;
} & AssistantModelProvenance &
  StepScoped;

export type AssistantThinkingPayload = {
  text: string;
  signature?: string;
  block?: ApiBlock;
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

/**
 * A user prompt. `steer: true` is the host's assertion that this prompt
 * arrived inside a run already in progress (a steering message): it joins the
 * open turn as a member and is never a turn boundary. Absent/false: the
 * prompt opens a turn (closing a populated open one first).
 */
export type UserPromptPayload = { text: string; steer?: boolean; blocks?: ApiBlock[] };
export type ToolResultPayload = {
  toolCallId: string;
  content: string;
  isError?: boolean;
  blocks?: ApiBlock[];
} & StepScoped;
export type ToolCallPayload = {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  block?: ApiBlock;
} & StepScoped;

export type MessageEventInput =
  | BaseEvent<"user_prompt", UserPromptPayload>
  | BaseEvent<"assistant_text", AssistantTextPayload>
  | BaseEvent<"assistant_thinking", AssistantThinkingPayload>
  | BaseEvent<"runtime_note", { text: string }>
  | BaseEvent<"model_change", { previousModel: string; newModel: string }>
  | BaseEvent<"thinking_level_change", { previousLevel: string; newLevel: string }>
  | BaseEvent<"tool_call", ToolCallPayload>
  | BaseEvent<"tool_result", ToolResultPayload>
  | BaseEvent<"compact_continuation_marker", CompactContinuationMarkerPayload>
  | BaseEvent<"turn_end", TurnEndPayload>;

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

/**
 * Constant-row durable position and identity for a thread: everything a
 * normal consumer needs to place itself in the archive without reading any
 * event payload. Three indexed single-row statements; nothing here grows with
 * archive size.
 */
export type ThreadFrontier = ThreadFrontierRow;

/** One entry per distinct requested prefix. */
export type EventKeyPrefixCount = EventKeyPrefixCountRow;

/** One matched key with its archive position. No payload is read. */
export type EventKeyReference = EventKeyRef;

/** One page of a legacy prefix walk. */
export type EventKeyPage = EventKeyPageResult;

/** Options for one page of a legacy prefix walk. */
export type EventKeyPageQuery = EventKeyPageOptions;

/**
 * Constant-row Thread frontier. Never reads or parses event payloads.
 */
export async function threadFrontier(threadRef: ThreadRef): Promise<OpResult<ThreadFrontier>> {
  return runThreadFrontier(threadRef);
}

/**
 * Existence and count for a finite, caller-supplied set of idempotency-key
 * prefixes, one indexed range query per distinct prefix.
 *
 * Contract: results carry one entry per *distinct* prefix in first-occurrence
 * order (duplicates collapse), so the result is O(input prefixes) rows.
 * Overlapping prefixes are evaluated independently — a key under both is
 * counted by both. An empty input list returns an empty result after the
 * thread reference is resolved. An empty or malformed prefix is an
 * `invalid_bounds` caller error: the whole archive is `listEvents`' explicit
 * job, not a projection.
 */
export async function eventKeyPrefixCounts(
  threadRef: ThreadRef,
  prefixes: readonly string[],
): Promise<OpResult<EventKeyPrefixCount[]>> {
  return runEventKeyPrefixCounts(threadRef, prefixes);
}

/**
 * Cursor-paginated key listing under one prefix — the lazy compatibility path
 * for legacy, ID-less occurrence resolution.
 *
 * Order is `idempotency_key` ascending (the unique index's own order). Events
 * are append-only and keys are immutable, so a page never repeats or reorders
 * rows already returned.
 *
 * `limit` defaults to and may not exceed `LEGACY_KEY_PAGE_LIMIT`; a larger or
 * non-integer limit is refused with `invalid_bounds` rather than clamped.
 * `LEGACY_KEY_TOTAL_LOOKUP_CAP` bounds one walk: when it stops the walk before
 * the prefix ends, the page reports `capExhausted: true` and `complete: false`
 * with a null cursor — a visible degraded result, never a partial answer
 * presented as the whole truth.
 */
export async function listEventKeysByPrefix(
  threadRef: ThreadRef,
  options: EventKeyPageQuery,
): Promise<OpResult<EventKeyPage>> {
  return runListEventKeysByPrefix(threadRef, options);
}
