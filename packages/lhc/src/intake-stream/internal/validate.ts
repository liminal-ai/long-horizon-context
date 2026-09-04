// Pure, whole-batch, three-layer closed validation. Strictness falls out of
// schema construction: every layer is a closed Effect Schema struct decoded
// under onExcessProperty: "error", so unknown-field rejection is a property of
// the definitions, not a remembered rule. Validation never touches a database;
// a rejected batch costs no write lock.
import { Either, ParseResult, Schema } from "effect";
import { type ErrorResult, isApiBlock, isPlainRecord } from "../../shared-tech/index.js";

export const EVENT_KINDS = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "runtime_note",
  "model_change",
  "thinking_level_change",
  "tool_call",
  "tool_result",
  "compact_continuation_marker",
  "turn_end",
] as const;

// Denied by name with their own reason string: the old MVP's
// silent-root-field-drop bug class gets named when it appears.
const SERVER_GENERATED_FIELDS = ["eventOrder", "recordedAt", "threadEventId", "schemaVersion"] as const;

const DECODE_OPTIONS = { onExcessProperty: "error", errors: "first" } as const;

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
// Host-supplied step index (schema v12): a non-negative integer, optional on
// the four step-bearing kinds only.
const StepIndex = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

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

// Layer 3 — per-kind payload, closed. turn_end may be empty or carry only the
// optional host-observed outcome/timing fields (D1). assistant_text may carry
// optional providerUsage as a verbatim JSON object (no inner shape).
const TextPayloadSchema = Schema.Struct({ text: Schema.String });
// user_prompt may carry the host's in-run steer assertion (turn parts, Flow 7)
// and the Messages API content blocks beyond its text.
const UserPromptPayloadSchema = Schema.Struct({
  text: Schema.String,
  steer: Schema.optional(Schema.Boolean),
  blocks: Schema.optional(Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown }))),
});
const AssistantTextPayloadSchema = Schema.Struct({
  text: Schema.String,
  providerUsage: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  api: Schema.optional(Schema.String),
  stepIndex: Schema.optional(StepIndex),
});
// signature is optional opaque provider bytes/token; empty string allowed only
// via omission — if present it must be a string (may be empty; hosts should
// omit rather than send ""). provider/model/api are optional host identity
// for resume (PI same-model signature keep).
const BlockSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const AssistantThinkingPayloadSchema = Schema.Struct({
  text: Schema.String,
  signature: Schema.optional(Schema.String),
  block: Schema.optional(BlockSchema),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  api: Schema.optional(Schema.String),
  stepIndex: Schema.optional(StepIndex),
});
const TurnEndPayloadSchema = Schema.Struct({
  outcome: Schema.optional(Schema.Literal("completed", "aborted")),
  outcomeReason: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.String),
});
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
  block: Schema.optional(BlockSchema),
  stepIndex: Schema.optional(StepIndex),
});
const ToolResultPayloadSchema = Schema.Struct({
  toolCallId: NonEmptyString,
  content: Schema.String,
  isError: Schema.optional(Schema.Boolean),
  blocks: Schema.optional(Schema.Array(BlockSchema)),
  stepIndex: Schema.optional(StepIndex),
});

// Which API block types each kind may carry, and where. The user's content
// set is the API's user-message set minus the kinds LHC records as their own
// events (tool_use, tool_result, thinking). A tool result nests the API's
// tool_result content set, plus the server-side result blocks the model
// receives inside its own message.
const USER_BLOCK_TYPES = new Set(["text", "image", "document", "search_result", "container_upload", "tool_reference"]);
const TOOL_RESULT_BLOCK_TYPES = new Set([
  "text",
  "image",
  "document",
  "search_result",
  "tool_reference",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function blockIssue(block: unknown, allowed: ReadonlySet<string>, path: string): string | undefined {
  if (!isApiBlock(block)) {
    const type = isPlainRecord(block) ? String(block["type"]) : typeof block;
    return `"${path}" is not a Messages API content block (type ${type})`;
  }
  if (!allowed.has(block.type)) return `"${path}" block type "${block.type}" is not allowed here`;
  const source = block["source"];
  if ((block.type === "image" || block.type === "document") && isPlainRecord(source) && source["type"] === "base64") {
    if (typeof source["media_type"] !== "string") return `"${path}.source.media_type" is required for a base64 source`;
    if (typeof source["data"] !== "string" || !BASE64_RE.test(source["data"])) {
      return `"${path}.source.data" must be a base64 string`;
    }
  }
  if (
    block.type === "tool_result" ||
    (block.type === "document" && isPlainRecord(source) && source["type"] === "content")
  ) {
    const inner = block.type === "tool_result" ? block["content"] : (source as Record<string, unknown>)["content"];
    if (Array.isArray(inner)) {
      for (const [i, child] of inner.entries()) {
        const issue = blockIssue(child, new Set(["text", "image"]), `${path}.content[${i}]`);
        if (issue !== undefined) return issue;
      }
    }
  }
  return undefined;
}

function blocksIssue(blocks: unknown, allowed: ReadonlySet<string>, key: string): string | undefined {
  if (blocks === undefined) return undefined;
  if (!Array.isArray(blocks)) return `"${key}" must be an array of content blocks`;
  for (const [i, block] of blocks.entries()) {
    const issue = blockIssue(block, allowed, `${key}[${i}]`);
    if (issue !== undefined) return issue;
  }
  return undefined;
}
// Typed compact-continuation marker: closed payload; semantics are contract-frozen.
const CompactContinuationMarkerPayloadSchema = Schema.Struct({
  kind: Schema.Literal("lhc.compact_continuation"),
  continuationTurnId: NonEmptyString,
  cause: Schema.Literal("context_compacted_task_in_progress"),
  action: Schema.Literal("continue_existing_task"),
  newUserRequest: Schema.Literal(false),
  waitForUser: Schema.Literal(false),
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

  let issue: string | undefined;
  switch (envelope.right.eventKind) {
    case "turn_end":
      issue = decodeIssue(TurnEndPayloadSchema, payload);
      break;
    case "assistant_text":
      issue = decodeIssue(AssistantTextPayloadSchema, payload);
      break;
    case "assistant_thinking":
      issue =
        decodeIssue(AssistantThinkingPayloadSchema, payload) ??
        blocksIssue(
          (payload as Record<string, unknown>)["block"] === undefined
            ? undefined
            : [(payload as Record<string, unknown>)["block"]],
          new Set(["redacted_thinking"]),
          "block",
        );
      break;
    case "tool_call":
      issue =
        decodeIssue(ToolCallPayloadSchema, payload) ??
        blocksIssue(
          (payload as Record<string, unknown>)["block"] === undefined
            ? undefined
            : [(payload as Record<string, unknown>)["block"]],
          new Set(["server_tool_use"]),
          "block",
        );
      break;
    case "tool_result":
      issue =
        decodeIssue(ToolResultPayloadSchema, payload) ??
        blocksIssue((payload as Record<string, unknown>)["blocks"], TOOL_RESULT_BLOCK_TYPES, "blocks");
      break;
    case "user_prompt":
      issue =
        decodeIssue(UserPromptPayloadSchema, payload) ??
        blocksIssue((payload as Record<string, unknown>)["blocks"], USER_BLOCK_TYPES, "blocks");
      break;
    case "model_change":
      issue = decodeIssue(ModelChangePayloadSchema, payload);
      break;
    case "thinking_level_change":
      issue = decodeIssue(ThinkingLevelChangePayloadSchema, payload);
      break;
    case "compact_continuation_marker":
      issue = decodeIssue(CompactContinuationMarkerPayloadSchema, payload);
      break;
    case "user_prompt":
      issue = decodeIssue(UserPromptPayloadSchema, payload);
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
