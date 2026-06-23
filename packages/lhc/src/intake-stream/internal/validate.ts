// Pure, whole-batch, three-layer closed validation. Strictness falls out of
// schema construction: every layer is a closed Effect Schema struct decoded
// under onExcessProperty: "error", so unknown-field rejection is a property of
// the definitions, not a remembered rule. Validation never touches a database;
// a rejected batch costs no write lock.
import { Either, ParseResult, Schema } from "effect";
import type { ErrorResult } from "../../shared-tech/index.js";

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

// Denied by name with their own reason string: the old MVP's
// silent-root-field-drop bug class gets named when it appears.
const SERVER_GENERATED_FIELDS = ["eventOrder", "recordedAt", "threadEventId", "schemaVersion"] as const;

const DECODE_OPTIONS = { onExcessProperty: "error", errors: "first" } as const;

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

// Layer 1 — envelope: thread reference shape, closed.
const ThreadRefSchema = Schema.Union(
  Schema.Struct({
    threadId: NonEmptyString,
    registryPath: Schema.optional(Schema.String),
  }),
  Schema.Struct({ filePath: NonEmptyString }),
);

// Layer 2 — event object: the five required fields, closed. payload presence
// and shape are layer 3's job (Schema.Unknown keeps the key from reading as
// an unexpected field here, and tolerates a missing key — presence is checked
// explicitly below).
const EventEnvelopeSchema = Schema.Struct({
  eventKind: Schema.Literal(...EVENT_KINDS),
  idempotencyKey: NonEmptyString,
  actor: NonEmptyString,
  harness: NonEmptyString,
  payload: Schema.Unknown,
});

// Layer 3 — per-kind payload, closed. turn_end's empty-payload rule is its
// own named check below (a closed Struct({}) admits any object).
const TextPayloadSchema = Schema.Struct({ text: Schema.String });
const ModelChangePayloadSchema = Schema.Struct({
  previousModel: NonEmptyString,
  newModel: NonEmptyString,
});
const ThinkingLevelChangePayloadSchema = Schema.Struct({
  previousLevel: NonEmptyString,
  newLevel: NonEmptyString,
});
const ToolCallPayloadSchema = Schema.Struct({
  toolCallId: NonEmptyString,
  toolName: NonEmptyString,
  arguments: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
const ToolResultPayloadSchema = Schema.Struct({
  toolCallId: NonEmptyString,
  content: Schema.String,
  isError: Schema.optional(Schema.Boolean),
});

function firstIssue(error: ParseResult.ParseError): string {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  const issue = issues[0];
  if (issue === undefined) return "invalid value";
  if (issue.path.length === 0) return issue.message;
  return `"${issue.path.join(".")}" ${issue.message}`;
}

function decodeIssue<A, I>(schema: Schema.Schema<A, I, never>, value: unknown): string | undefined {
  const decoded = Schema.decodeUnknownEither(schema, DECODE_OPTIONS)(value);
  return Either.isLeft(decoded) ? firstIssue(decoded.left) : undefined;
}

function callerError(reason: string, eventIndex?: number): ErrorResult {
  const error: ErrorResult = {
    errorClass: "caller_error",
    code: "invalid_event",
    reason,
  };
  if (eventIndex !== undefined) error.eventIndex = eventIndex;
  return error;
}

// Envelope-level: the thread reference must decode against the closed union.
// Returns undefined when valid.
export function validateThreadRef(ref: unknown): ErrorResult | undefined {
  const issue = decodeIssue(ThreadRefSchema, ref);
  if (issue !== undefined) {
    return callerError(`envelope: invalid thread reference — ${issue}`);
  }
  return undefined;
}

// Whole-batch validation: array order, first failure wins. Returns undefined
// when every event is valid.
export function validateEvents(events: unknown): ErrorResult | undefined {
  if (!Array.isArray(events)) {
    return callerError("envelope: events must be a JSON array");
  }
  if (events.length === 0) {
    return {
      errorClass: "caller_error",
      code: "empty_batch",
      reason: "envelope: events array is empty; a batch must carry at least one event",
    };
  }
  for (const [index, event] of events.entries()) {
    const failure = validateOneEvent(event, index);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function validateOneEvent(event: unknown, index: number): ErrorResult | undefined {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return callerError("event: each event must be a JSON object", index);
  }
  const record = event as Record<string, unknown>;

  for (const field of SERVER_GENERATED_FIELDS) {
    if (field in record) {
      return callerError(`event: server-generated field "${field}" must not be supplied by the caller`, index);
    }
  }

  const kind = record["eventKind"];
  if (typeof kind === "string" && !(EVENT_KINDS as readonly string[]).includes(kind)) {
    return callerError(`event: unknown event kind "${kind}"`, index);
  }

  const envelope = Schema.decodeUnknownEither(EventEnvelopeSchema, DECODE_OPTIONS)(event);
  if (Either.isLeft(envelope)) {
    return callerError(`event: ${firstIssue(envelope.left)}`, index);
  }

  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return callerError("event: payload must be a JSON object", index);
  }

  if (envelope.right.eventKind === "turn_end") {
    const extraKeys = Object.keys(payload);
    if (extraKeys.length > 0) {
      return callerError(`payload: turn_end events carry an empty payload; found field "${extraKeys[0]}"`, index);
    }
    return undefined;
  }

  let issue: string | undefined;
  switch (envelope.right.eventKind) {
    case "tool_call":
      issue = decodeIssue(ToolCallPayloadSchema, payload);
      break;
    case "tool_result":
      issue = decodeIssue(ToolResultPayloadSchema, payload);
      break;
    case "model_change":
      issue = decodeIssue(ModelChangePayloadSchema, payload);
      break;
    case "thinking_level_change":
      issue = decodeIssue(ThinkingLevelChangePayloadSchema, payload);
      break;
    default:
      issue = decodeIssue(TextPayloadSchema, payload);
      break;
  }
  if (issue !== undefined) {
    return callerError(`payload: ${issue}`, index);
  }
  return undefined;
}
