import { ParseResult, Schema } from "effect";

export const THREAD_EVENT_SCHEMA_VERSION = "thread_event.v1" as const;

export const ThreadEventKindSchema = Schema.Literal(
  "thread_created",
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "tool_call",
  "tool_result",
  "runtime_note",
  "turn_end",
);
export type ThreadEventKind = Schema.Schema.Type<typeof ThreadEventKindSchema>;

export const AppendThreadEventKindSchema = Schema.Literal(
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "tool_call",
  "tool_result",
  "runtime_note",
  "turn_end",
);
export type AppendThreadEventKind = Schema.Schema.Type<typeof AppendThreadEventKindSchema>;

export const ActorKindSchema = Schema.Literal("user", "assistant", "tool", "runtime", "system");
export type ActorKind = Schema.Schema.Type<typeof ActorKindSchema>;

const NonEmptyStringSchema = Schema.String.pipe(Schema.nonEmptyString());

export const ActorRefSchema = Schema.Struct({
  actorKind: ActorKindSchema,
  actorId: NonEmptyStringSchema,
  displayName: Schema.optional(Schema.String),
});
export type ActorRef = Schema.Schema.Type<typeof ActorRefSchema>;

export const HarnessRefSchema = Schema.Struct({
  runtime: NonEmptyStringSchema,
  externalThreadId: Schema.optional(Schema.String),
});
export type HarnessRef = Schema.Schema.Type<typeof HarnessRefSchema>;

export const OriginRefSchema = Schema.Struct({
  envelopeId: Schema.optional(NonEmptyStringSchema),
  envelopeOrder: Schema.optional(Schema.Number),
  eventId: Schema.optional(NonEmptyStringSchema),
  eventOrder: Schema.optional(Schema.Number),
});
export type OriginRef = Schema.Schema.Type<typeof OriginRefSchema>;

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record({ key: Schema.String, value: JsonValueSchema }),
  ),
);
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const JsonObjectSchema = Schema.Record({ key: Schema.String, value: JsonValueSchema });
export type JsonObject = Schema.Schema.Type<typeof JsonObjectSchema>;

export const SystemKindSchema = Schema.Literal(
  "session",
  "instruction",
  "configuration",
  "lifecycle",
  "runtime_error",
  "context_change",
  "attachment",
);
export type SystemKind = Schema.Schema.Type<typeof SystemKindSchema>;

const BaseAppendInputFields = {
  idempotencyKey: NonEmptyStringSchema,
  actor: ActorRefSchema,
  harness: HarnessRefSchema,
  origin: Schema.optional(OriginRefSchema),
  occurredAt: Schema.optional(Schema.String),
} as const;

export const ThreadCreateInputSchema = Schema.Struct({
  clientThreadId: NonEmptyStringSchema,
  title: Schema.optional(Schema.String),
});
export type ThreadCreateInput = Schema.Schema.Type<typeof ThreadCreateInputSchema>;

export const ThreadCreatedPayloadSchema = Schema.Struct({
  _tag: Schema.Literal("thread_created"),
  clientThreadId: NonEmptyStringSchema,
  title: Schema.optional(Schema.String),
});
export type ThreadCreatedPayload = Schema.Schema.Type<typeof ThreadCreatedPayloadSchema>;

const UserPromptPayloadInputSchema = Schema.Struct({
  text: Schema.String,
});

export const UserPromptPayloadSchema = Schema.Struct({
  _tag: Schema.Literal("user_prompt"),
  text: Schema.String,
});
export type UserPromptPayload = Schema.Schema.Type<typeof UserPromptPayloadSchema>;

const AssistantTextPayloadInputSchema = Schema.Struct({
  text: Schema.String,
});

export const AssistantTextPayloadSchema = Schema.Struct({
  _tag: Schema.Literal("assistant_text"),
  text: Schema.String,
});
export type AssistantTextPayload = Schema.Schema.Type<typeof AssistantTextPayloadSchema>;

const ReasoningPayloadFields = {
  thinkingKind: Schema.Literal("reasoning"),
  text: Schema.String,
  signature: Schema.optional(Schema.String),
} as const;

const ReasoningSummaryPayloadFields = {
  thinkingKind: Schema.Literal("reasoning_summary"),
  text: Schema.String,
  signature: Schema.optional(Schema.String),
} as const;

const EncryptedReasoningPayloadFields = {
  thinkingKind: Schema.Literal("encrypted_reasoning"),
  encryptedContent: Schema.String,
  signature: Schema.optional(Schema.String),
} as const;

const AssistantThinkingPayloadInputSchema = Schema.Union(
  Schema.Struct(ReasoningPayloadFields),
  Schema.Struct(ReasoningSummaryPayloadFields),
  Schema.Struct(EncryptedReasoningPayloadFields),
);

export const AssistantThinkingPayloadSchema = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("assistant_thinking"), ...ReasoningPayloadFields }),
  Schema.Struct({ _tag: Schema.Literal("assistant_thinking"), ...ReasoningSummaryPayloadFields }),
  Schema.Struct({ _tag: Schema.Literal("assistant_thinking"), ...EncryptedReasoningPayloadFields }),
);
export type AssistantThinkingPayload = Schema.Schema.Type<typeof AssistantThinkingPayloadSchema>;

const ToolCallPayloadInputSchema = Schema.Struct({
  toolCallId: NonEmptyStringSchema,
  toolName: NonEmptyStringSchema,
  argumentsJson: Schema.optional(JsonValueSchema),
});

export const ToolCallPayloadSchema = Schema.Struct({
  _tag: Schema.Literal("tool_call"),
  toolCallId: NonEmptyStringSchema,
  toolName: NonEmptyStringSchema,
  argumentsJson: Schema.optional(JsonValueSchema),
});
export type ToolCallPayload = Schema.Schema.Type<typeof ToolCallPayloadSchema>;

const ToolResultPayloadInputSchema = Schema.Struct({
  toolCallId: NonEmptyStringSchema,
  text: Schema.optional(Schema.String),
  resultJson: Schema.optional(JsonValueSchema),
  isError: Schema.optional(Schema.Boolean),
});

export const ToolResultPayloadSchema = Schema.Struct({
  _tag: Schema.Literal("tool_result"),
  toolCallId: NonEmptyStringSchema,
  text: Schema.optional(Schema.String),
  resultJson: Schema.optional(JsonValueSchema),
  isError: Schema.optional(Schema.Boolean),
});
export type ToolResultPayload = Schema.Schema.Type<typeof ToolResultPayloadSchema>;

const RuntimeNotePayloadInputSchema = Schema.Struct({
  text: Schema.String,
  systemKind: Schema.optional(SystemKindSchema),
  metadata: Schema.optional(JsonObjectSchema),
});

export const RuntimeNotePayloadSchema = Schema.Struct({
  _tag: Schema.Literal("runtime_note"),
  text: Schema.String,
  systemKind: Schema.optional(SystemKindSchema),
  metadata: Schema.optional(JsonObjectSchema),
});
export type RuntimeNotePayload = Schema.Schema.Type<typeof RuntimeNotePayloadSchema>;

const TurnEndPayloadInputSchema = Schema.Struct({});

export const TurnEndPayloadSchema = Schema.Struct({
  _tag: Schema.Literal("turn_end"),
});
export type TurnEndPayload = Schema.Schema.Type<typeof TurnEndPayloadSchema>;

export const ThreadEventPayloadSchema = Schema.Union(
  ThreadCreatedPayloadSchema,
  UserPromptPayloadSchema,
  AssistantTextPayloadSchema,
  AssistantThinkingPayloadSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  RuntimeNotePayloadSchema,
  TurnEndPayloadSchema,
);
export type ThreadEventPayload = Schema.Schema.Type<typeof ThreadEventPayloadSchema>;

export const ThreadEventAppendInputSchema = Schema.Union(
  Schema.Struct({ ...BaseAppendInputFields, eventKind: Schema.Literal("user_prompt"), payload: UserPromptPayloadInputSchema }),
  Schema.Struct({ ...BaseAppendInputFields, eventKind: Schema.Literal("assistant_text"), payload: AssistantTextPayloadInputSchema }),
  Schema.Struct({ ...BaseAppendInputFields, eventKind: Schema.Literal("assistant_thinking"), payload: AssistantThinkingPayloadInputSchema }),
  Schema.Struct({ ...BaseAppendInputFields, eventKind: Schema.Literal("tool_call"), payload: ToolCallPayloadInputSchema }),
  Schema.Struct({ ...BaseAppendInputFields, eventKind: Schema.Literal("tool_result"), payload: ToolResultPayloadInputSchema }),
  Schema.Struct({ ...BaseAppendInputFields, eventKind: Schema.Literal("runtime_note"), payload: RuntimeNotePayloadInputSchema }),
  Schema.Struct({ ...BaseAppendInputFields, eventKind: Schema.Literal("turn_end"), payload: TurnEndPayloadInputSchema }),
);
export type ThreadEventAppendInput = Schema.Schema.Type<typeof ThreadEventAppendInputSchema>;

const ThreadEventAppendEnvelopeSchema = Schema.Struct({
  ...BaseAppendInputFields,
  eventKind: AppendThreadEventKindSchema,
  payload: JsonObjectSchema,
});

export const AppendThreadEventsInputSchema = Schema.Struct({
  clientThreadId: NonEmptyStringSchema,
  events: Schema.Array(ThreadEventAppendInputSchema),
});
export type AppendThreadEventsInput = Schema.Schema.Type<typeof AppendThreadEventsInputSchema>;

export const AppendThreadEventsEnvelopeInputSchema = Schema.Struct({
  clientThreadId: NonEmptyStringSchema,
  events: Schema.Array(Schema.Unknown),
});
export type AppendThreadEventsEnvelopeInput = Schema.Schema.Type<typeof AppendThreadEventsEnvelopeInputSchema>;

export const PersistedThreadEventSchema = Schema.Struct({
  threadEventId: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  eventOrder: Schema.Number,
  schemaVersion: Schema.Literal(THREAD_EVENT_SCHEMA_VERSION),
  eventKind: ThreadEventKindSchema,
  idempotencyKey: NonEmptyStringSchema,
  actor: ActorRefSchema,
  harness: HarnessRefSchema,
  origin: Schema.optional(OriginRefSchema),
  recordedAt: Schema.String,
  occurredAt: Schema.optional(Schema.String),
  payload: ThreadEventPayloadSchema,
});
export type PersistedThreadEvent = Schema.Schema.Type<typeof PersistedThreadEventSchema>;

export type NormalizedThreadEventAppendInput = Omit<ThreadEventAppendInput, "payload"> & {
  payload: Exclude<ThreadEventPayload, ThreadCreatedPayload>;
};

export class ThreadEventValidationError extends Error {
  readonly causeValue?: unknown;

  constructor(message: string, causeValue?: unknown) {
    super(message);
    this.name = "ThreadEventValidationError";
    this.causeValue = causeValue;
  }
}

export function decodeThreadCreateInput(value: unknown): ThreadCreateInput {
  assertInputDoesNotProvideGeneratedFields(value);
  return decodeOrThrow(ThreadCreateInputSchema, value, "Invalid thread create input");
}

export function decodeAppendThreadEventsInput(value: unknown): AppendThreadEventsInput {
  assertInputDoesNotProvideGeneratedFields(value);
  const input = decodeOrThrow(AppendThreadEventsInputSchema, value, "Invalid thread events append input");
  for (const event of input.events) {
    assertInputDoesNotProvideGeneratedFields(event);
    rejectLegacyThinkingRuntimeNote(event);
  }
  return input;
}

export function decodeAppendThreadEventsEnvelopeInput(value: unknown): AppendThreadEventsEnvelopeInput {
  assertInputDoesNotProvideGeneratedFields(value);
  return decodeOrThrow(AppendThreadEventsEnvelopeInputSchema, value, "Invalid thread events append envelope input");
}

export function decodeThreadEventAppendInput(value: unknown): NormalizedThreadEventAppendInput {
  assertInputDoesNotProvideGeneratedFields(value);
  const input = decodeOrThrow(ThreadEventAppendEnvelopeSchema, value, "Invalid thread event append input");
  rejectLegacyThinkingRuntimeNote(input);
  return {
    ...input,
    payload: normalizePayload(input.eventKind, input.payload) as Exclude<ThreadEventPayload, ThreadCreatedPayload>,
  };
}

export function decodePersistedThreadEvent(value: unknown): PersistedThreadEvent {
  return decodeOrThrow(PersistedThreadEventSchema, value, "Invalid persisted thread event");
}

export function normalizePayload(eventKind: ThreadEventKind, payload: JsonObject): ThreadEventPayload {
  if ("_tag" in payload) {
    throw new ThreadEventValidationError("Thread event append payload must not include generated field: _tag", payload);
  }

  const normalized = { ...payload, _tag: eventKind };
  switch (eventKind) {
    case "thread_created":
      return decodeOrThrow(ThreadCreatedPayloadSchema, normalized, "Invalid thread_created payload");
    case "user_prompt":
      return decodeOrThrow(UserPromptPayloadSchema, normalized, "Invalid user_prompt payload");
    case "assistant_text":
      return decodeOrThrow(AssistantTextPayloadSchema, normalized, "Invalid assistant_text payload");
    case "assistant_thinking":
      return decodeOrThrow(AssistantThinkingPayloadSchema, normalized, "Invalid assistant_thinking payload");
    case "tool_call":
      return decodeOrThrow(ToolCallPayloadSchema, normalized, "Invalid tool_call payload");
    case "tool_result":
      return decodeOrThrow(ToolResultPayloadSchema, normalized, "Invalid tool_result payload");
    case "runtime_note":
      return decodeOrThrow(RuntimeNotePayloadSchema, normalized, "Invalid runtime_note payload");
    case "turn_end":
      return decodeOrThrow(TurnEndPayloadSchema, normalized, "Invalid turn_end payload");
  }
}

function assertInputDoesNotProvideGeneratedFields(value: unknown): void {
  if (!isJsonObject(value)) return;
  const generatedFields = ["schemaVersion", "threadEventId", "threadId", "eventOrder", "recordedAt"].filter((field) => field in value);
  if (generatedFields.length > 0) {
    throw new ThreadEventValidationError(
      `Thread event input must not include generated field(s): ${generatedFields.join(", ")}`,
      value,
    );
  }
}

function rejectLegacyThinkingRuntimeNote(value: { eventKind?: unknown; payload?: unknown }): void {
  if (value.eventKind !== "runtime_note" || !isJsonObject(value.payload)) return;
  if (value.payload.type === "thinking" || value.payload.thinkingKind !== undefined) {
    throw new ThreadEventValidationError(
      "runtime_note must not be used as a legacy thinking junk drawer; use assistant_thinking for canonical thinking events",
      value,
    );
  }
}

function decodeOrThrow<A, I>(schema: Schema.Schema<A, I, never>, value: unknown, message: string): A {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch (error) {
    throw new ThreadEventValidationError(`${message}: ${formatParseError(error)}`, value);
  }
}

function formatParseError(error: unknown): string {
  if (ParseResult.isParseError(error)) {
    return ParseResult.TreeFormatter.formatErrorSync(error);
  }
  return error instanceof Error ? error.message : String(error);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
