import type { ErrorResult } from "../client/types.js";

export const EVENT_KINDS = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "runtime_note",
  "model_change",
  "thinking_level_change",
  "tool_call",
  "tool_result",
  "turn_end",
] as const;

const SERVER_GENERATED_FIELDS = ["eventOrder", "recordedAt", "threadEventId", "schemaVersion"] as const;
const EVENT_FIELDS = new Set(["eventKind", "idempotencyKey", "actor", "harness", "payload"]);

function callerError(reason: string, eventIndex?: number, code: "invalid_event" | "empty_batch" = "invalid_event") {
  return {
    errorClass: "caller_error" as const,
    code,
    reason,
    ...(eventIndex === undefined ? {} : { eventIndex }),
  } satisfies ErrorResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function firstExtra(record: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(record).find((key) => !allowed.has(key));
}

export function validateThreadRef(ref: unknown): ErrorResult | undefined {
  if (!isRecord(ref)) return callerError("envelope: invalid thread reference — expected an object");
  if ("threadId" in ref) {
    const extra = firstExtra(ref, new Set(["threadId", "registryPath"]));
    if (!nonEmptyString(ref["threadId"])) {
      return callerError('envelope: invalid thread reference — "threadId" must be a non-empty string');
    }
    if (ref["registryPath"] !== undefined && typeof ref["registryPath"] !== "string") {
      return callerError('envelope: invalid thread reference — "registryPath" must be a string');
    }
    if (extra !== undefined) return callerError(`envelope: invalid thread reference — unexpected field "${extra}"`);
    return undefined;
  }
  const extra = firstExtra(ref, new Set(["filePath"]));
  if (!nonEmptyString(ref["filePath"])) {
    return callerError('envelope: invalid thread reference — "filePath" must be a non-empty string');
  }
  if (extra !== undefined) return callerError(`envelope: invalid thread reference — unexpected field "${extra}"`);
  return undefined;
}

export function validateEvents(events: unknown): ErrorResult | undefined {
  if (!Array.isArray(events)) return callerError("envelope: events must be a JSON array");
  if (events.length === 0) {
    return callerError(
      "envelope: events array is empty; a batch must carry at least one event",
      undefined,
      "empty_batch",
    );
  }
  for (const [index, event] of events.entries()) {
    const failure = validateOneEvent(event, index);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function validateOneEvent(event: unknown, index: number): ErrorResult | undefined {
  if (!isRecord(event)) return callerError("event: each event must be a JSON object", index);
  for (const field of SERVER_GENERATED_FIELDS) {
    if (field in event) {
      return callerError(`event: server-generated field "${field}" must not be supplied by the caller`, index);
    }
  }
  const extra = firstExtra(event, EVENT_FIELDS);
  if (extra !== undefined) return callerError(`event: unexpected field "${extra}"`, index);
  const kind = event["eventKind"];
  if (typeof kind === "string" && !(EVENT_KINDS as readonly string[]).includes(kind)) {
    return callerError(`event: unknown event kind "${kind}"`, index);
  }
  if (!(EVENT_KINDS as readonly unknown[]).includes(kind)) {
    return callerError('event: "eventKind" must be a known event kind', index);
  }
  for (const field of ["idempotencyKey", "actor", "harness"] as const) {
    if (!nonEmptyString(event[field])) return callerError(`event: "${field}" must be a non-empty string`, index);
  }
  const payload = event["payload"];
  if (!isRecord(payload)) return callerError("event: payload must be a JSON object", index);
  return validatePayload(kind as (typeof EVENT_KINDS)[number], payload, index);
}

function validatePayload(
  kind: (typeof EVENT_KINDS)[number],
  payload: Record<string, unknown>,
  index: number,
): ErrorResult | undefined {
  if (kind === "turn_end") {
    const field = Object.keys(payload)[0];
    return field === undefined
      ? undefined
      : callerError(`payload: turn_end events carry an empty payload; found field "${field}"`, index);
  }
  const fields =
    kind === "tool_call"
      ? new Set(["toolCallId", "toolName", "arguments"])
      : kind === "tool_result"
        ? new Set(["toolCallId", "content", "isError"])
        : kind === "model_change"
          ? new Set(["previousModel", "newModel"])
          : kind === "thinking_level_change"
            ? new Set(["previousLevel", "newLevel"])
            : new Set(["text"]);
  const extra = firstExtra(payload, fields);
  if (extra !== undefined) return callerError(`payload: unexpected field "${extra}"`, index);
  if (kind === "tool_call") {
    if (
      !nonEmptyString(payload["toolCallId"]) ||
      !nonEmptyString(payload["toolName"]) ||
      !isRecord(payload["arguments"])
    ) {
      return callerError(
        "payload: toolCallId/toolName must be non-empty strings and arguments must be an object",
        index,
      );
    }
  } else if (kind === "tool_result") {
    if (!nonEmptyString(payload["toolCallId"]) || typeof payload["content"] !== "string") {
      return callerError("payload: toolCallId must be non-empty and content must be a string", index);
    }
    if (payload["isError"] !== undefined && typeof payload["isError"] !== "boolean") {
      return callerError('payload: "isError" must be a boolean', index);
    }
  } else if (kind === "model_change") {
    if (!nonEmptyString(payload["previousModel"]) || !nonEmptyString(payload["newModel"])) {
      return callerError("payload: previousModel and newModel must be non-empty strings", index);
    }
  } else if (kind === "thinking_level_change") {
    if (!nonEmptyString(payload["previousLevel"]) || !nonEmptyString(payload["newLevel"])) {
      return callerError("payload: previousLevel and newLevel must be non-empty strings", index);
    }
  } else if (typeof payload["text"] !== "string") {
    return callerError('payload: "text" must be a string', index);
  }
  return undefined;
}
