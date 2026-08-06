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
const EVENT_EXPECTED = '"eventKind" | "idempotencyKey" | "actor" | "harness" | "payload"';

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

function actual(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${String(value)}n`;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function required(record: Record<string, unknown>, field: string): string | undefined {
  return field in record ? undefined : `"${field}" is missing`;
}

function stringIssue(record: Record<string, unknown>, field: string, nonEmpty: boolean): string | undefined {
  const missing = required(record, field);
  if (missing !== undefined) return missing;
  const value = record[field];
  if (typeof value !== "string") return `"${field}" Expected string, actual ${actual(value)}`;
  if (nonEmpty && value.length === 0) {
    return `"${field}" Expected a string at least 1 character(s) long, actual ""`;
  }
  return undefined;
}

function unexpected(field: string, expected: string): string {
  return `"${field}" is unexpected, expected: ${expected}`;
}

export function validateThreadRef(ref: unknown): ErrorResult | undefined {
  const threadExpected = '"threadId" | "registryPath"';
  const expectedStruct = "{ readonly threadId: minLength(1); readonly registryPath?: string | undefined }";
  if (!isRecord(ref)) {
    return callerError(`envelope: invalid thread reference — Expected ${expectedStruct}, actual ${actual(ref)}`);
  }
  if ("threadId" in ref) {
    const extra = firstExtra(ref, new Set(["threadId", "registryPath"]));
    const threadIssue = stringIssue(ref, "threadId", true);
    if (threadIssue !== undefined) return callerError(`envelope: invalid thread reference — ${threadIssue}`);
    if ("registryPath" in ref && ref["registryPath"] !== undefined && typeof ref["registryPath"] !== "string") {
      return callerError(
        `envelope: invalid thread reference — "registryPath" Expected string, actual ${actual(ref["registryPath"])}`,
      );
    }
    if (extra !== undefined) {
      return callerError(`envelope: invalid thread reference — ${unexpected(extra, threadExpected)}`);
    }
    return undefined;
  }
  if (Object.keys(ref).length === 1 && nonEmptyString(ref["filePath"])) return undefined;

  // Effect's Union reports the first branch's first issue when neither branch
  // decodes. Preserve that observable reason contract without carrying Effect
  // into the Convex isolate.
  const firstBranchExtra = firstExtra(ref, new Set(["threadId", "registryPath"]));
  const issue = firstBranchExtra === undefined ? '"threadId" is missing' : unexpected(firstBranchExtra, threadExpected);
  return callerError(`envelope: invalid thread reference — ${issue}`);
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
  if (extra !== undefined) return callerError(`event: ${unexpected(extra, EVENT_EXPECTED)}`, index);
  const kind = event["eventKind"];
  if (typeof kind === "string" && !(EVENT_KINDS as readonly string[]).includes(kind)) {
    return callerError(`event: unknown event kind "${kind}"`, index);
  }
  if (!(EVENT_KINDS as readonly unknown[]).includes(kind)) {
    const issue =
      "eventKind" in event ? `"eventKind" Expected "user_prompt", actual ${actual(kind)}` : '"eventKind" is missing';
    return callerError(`event: ${issue}`, index);
  }
  for (const field of ["idempotencyKey", "actor", "harness"] as const) {
    const issue = stringIssue(event, field, true);
    if (issue !== undefined) return callerError(`event: ${issue}`, index);
  }
  const payload = event["payload"];
  if (!isRecord(payload)) return callerError("event: payload must be a JSON object", index);
  return validatePayload(kind as (typeof EVENT_KINDS)[number], payload, index);
}

// turn_end may be empty or carry only these optional host-observed fields (D1).
const TURN_END_FIELDS = new Set(["outcome", "outcomeReason", "startedAt", "endedAt"]);
const TURN_END_EXPECTED = '"outcome" | "outcomeReason" | "startedAt" | "endedAt"';
const OUTCOME_VALUES = new Set(["completed", "aborted"]);

function validatePayload(
  kind: (typeof EVENT_KINDS)[number],
  payload: Record<string, unknown>,
  index: number,
): ErrorResult | undefined {
  if (kind === "turn_end") {
    // Closed optional struct: empty is valid; unknown keys rejected; outcome is
    // a closed vocab. Matches the py/rs deliberate surface for
    // Schema.Literal("completed", "aborted") (full union, not Effect's first-
    // only report).
    const extra = firstExtra(payload, TURN_END_FIELDS);
    if (extra !== undefined) {
      return callerError(`payload: ${unexpected(extra, TURN_END_EXPECTED)}`, index);
    }
    if ("outcome" in payload && payload["outcome"] !== undefined) {
      const value = payload["outcome"];
      if (typeof value !== "string" || !OUTCOME_VALUES.has(value)) {
        return callerError(`payload: "outcome" Expected "completed" | "aborted", actual ${actual(value)}`, index);
      }
    }
    for (const field of ["outcomeReason", "startedAt", "endedAt"] as const) {
      if (!(field in payload) || payload[field] === undefined) continue;
      if (typeof payload[field] !== "string") {
        return callerError(`payload: "${field}" Expected string, actual ${actual(payload[field])}`, index);
      }
    }
    return undefined;
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
            : kind === "assistant_text"
              ? new Set(["text", "providerUsage"])
              : new Set(["text"]);
  const extra = firstExtra(payload, fields);
  if (extra !== undefined) {
    return callerError(
      `payload: ${unexpected(extra, [...fields].map((field) => JSON.stringify(field)).join(" | "))}`,
      index,
    );
  }
  if (kind === "tool_call") {
    const callIdIssue = stringIssue(payload, "toolCallId", true);
    if (callIdIssue !== undefined) return callerError(`payload: ${callIdIssue}`, index);
    const toolNameIssue = stringIssue(payload, "toolName", true);
    if (toolNameIssue !== undefined) return callerError(`payload: ${toolNameIssue}`, index);
    const missingArguments = required(payload, "arguments");
    if (missingArguments !== undefined) return callerError(`payload: ${missingArguments}`, index);
    if (!isRecord(payload["arguments"])) {
      return callerError(
        `payload: "arguments" Expected { readonly [x: string]: unknown }, actual ${actual(payload["arguments"])}`,
        index,
      );
    }
  } else if (kind === "tool_result") {
    const callIdIssue = stringIssue(payload, "toolCallId", true);
    if (callIdIssue !== undefined) return callerError(`payload: ${callIdIssue}`, index);
    const contentIssue = stringIssue(payload, "content", false);
    if (contentIssue !== undefined) return callerError(`payload: ${contentIssue}`, index);
    if ("isError" in payload && payload["isError"] !== undefined && typeof payload["isError"] !== "boolean") {
      return callerError(`payload: "isError" Expected boolean, actual ${actual(payload["isError"])}`, index);
    }
  } else if (kind === "model_change") {
    const previousIssue = stringIssue(payload, "previousModel", true);
    if (previousIssue !== undefined) return callerError(`payload: ${previousIssue}`, index);
    const nextIssue = stringIssue(payload, "newModel", true);
    if (nextIssue !== undefined) return callerError(`payload: ${nextIssue}`, index);
  } else if (kind === "thinking_level_change") {
    const previousIssue = stringIssue(payload, "previousLevel", true);
    if (previousIssue !== undefined) return callerError(`payload: ${previousIssue}`, index);
    const nextIssue = stringIssue(payload, "newLevel", true);
    if (nextIssue !== undefined) return callerError(`payload: ${nextIssue}`, index);
  } else if (kind === "assistant_text") {
    // text required; providerUsage optional verbatim JSON object (no inner shape).
    const textIssue = stringIssue(payload, "text", false);
    if (textIssue !== undefined) return callerError(`payload: ${textIssue}`, index);
    if ("providerUsage" in payload && payload["providerUsage"] !== undefined) {
      if (!isRecord(payload["providerUsage"])) {
        return callerError(
          `payload: "providerUsage" Expected { readonly [x: string]: unknown }, actual ${actual(payload["providerUsage"])}`,
          index,
        );
      }
    }
  } else {
    const textIssue = stringIssue(payload, "text", false);
    if (textIssue !== undefined) return callerError(`payload: ${textIssue}`, index);
  }
  return undefined;
}
