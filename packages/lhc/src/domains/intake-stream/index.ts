import { notImplemented, type OpResult } from "../../shared/errors.js";
import type {
  WorkKind,
  WorkOwner,
  WorkSourceRef,
} from "../../tech-utils/work-queue/index.js";
import type { ThreadRef } from "../threads/index.js";

interface BaseEvent<K extends string, P> {
  eventKind: K;
  idempotencyKey: string;
  actor: string; // non-empty
  harness: string; // non-empty
  payload: P; // shape fixed by kind, closed
}

export type MessageEventInput =
  | BaseEvent<"user_prompt", { text: string }>
  | BaseEvent<"assistant_text", { text: string }>
  | BaseEvent<"assistant_thinking", { text: string }>
  | BaseEvent<"runtime_note", { text: string }>
  | BaseEvent<
      "tool_call",
      { toolCallId: string; toolName: string; arguments: Record<string, unknown> }
    >
  | BaseEvent<"tool_result", { toolCallId: string; content: string; isError?: boolean }>
  | BaseEvent<"turn_end", Record<string, never>>;

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
  _thread: ThreadRef,
  _events: readonly MessageEventInput[],
): Promise<OpResult<BatchResult>> {
  return notImplemented("intake-stream.message-events");
}

export async function listEvents(
  _thread: ThreadRef,
): Promise<OpResult<EventRecord[]>> {
  return notImplemented("intake-stream.list-events");
}
