// Synthetic builders for the two test edges (tech design §Fixture Contracts):
//   - PI `AgentMessage` / event builders feed the PI hook edge where a precise
//     hand-built shape beats a recorded one (lifecycle + turn-derivation tests).
//   - `validEvent` builds a single, correctly-typed LHC `MessageEventInput` so
//     a kind/payload mismatch is a compile error, not a runtime surprise.
import type { EventKind, MessageEventInput } from "lhc";
import type {
  AgentEndEvent,
  AgentMessage,
  AssistantMessage,
  ContentPart,
  MessageEndEvent,
  PiStopReason,
  SessionStartEvent,
  SessionStartReason,
  ToolResultMessage,
  UserMessage,
} from "../../src/pi/types.js";

// ── LHC intake-event builder ─────────────────────────────────────────

export type EventByKind<K extends EventKind> = Extract<MessageEventInput, { eventKind: K }>;

let keyCounter = 0;
/** Reset the per-call key counter so a test can build deterministic keys. */
export function resetEventKeyCounter(): void {
  keyCounter = 0;
}

const defaultPayloads: { [K in EventKind]: () => EventByKind<K>["payload"] } = {
  user_prompt: () => ({ text: "please read the file" }),
  assistant_text: () => ({ text: "here is what I found" }),
  assistant_thinking: () => ({ text: "considering the file contents" }),
  runtime_note: () => ({ text: "model changed: anthropic/claude → openai/gpt" }),
  tool_call: () => ({ toolCallId: "call-1", toolName: "read_file", arguments: { path: "notes.txt" } }),
  tool_result: () => ({ toolCallId: "call-1", content: "contents of notes.txt", isError: false }),
  turn_end: () => ({}),
};

/** The discriminated `MessageEventInput` member for its kind. A kind/payload
 *  mismatch at a call site is a compile error; the final reconciliation goes
 *  through `unknown` (TS can't reduce a structural spread to the deferred
 *  Extract), with call-site safety living in the parameter types. */
export function validEvent<K extends EventKind>(
  kind: K,
  overrides: Partial<Omit<EventByKind<K>, "eventKind">> = {},
): EventByKind<K> {
  keyCounter += 1;
  const base = {
    eventKind: kind,
    idempotencyKey: `pi-lhc-fixture-${keyCounter}`,
    actor: "fixture-actor",
    harness: "pi",
    payload: defaultPayloads[kind](),
  };
  return { ...base, ...overrides } as unknown as EventByKind<K>;
}

export function eventBatch(kinds: readonly EventKind[]): MessageEventInput[] {
  return kinds.map((kind) => validEvent(kind));
}

// ── PI message builders ──────────────────────────────────────────────

export function makeUserMessage(text = "please read the file"): UserMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

export interface AssistantToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** Fans out to content parts in PI's confirmed order: thinking → text →
 *  toolCall×N (research §5a). */
export function makeAssistantMessage(
  opts: {
    thinking?: string;
    text?: string;
    toolCalls?: AssistantToolCall[];
    stopReason?: PiStopReason;
  } = {},
): AssistantMessage {
  const content: ContentPart[] = [];
  if (opts.thinking !== undefined) content.push({ type: "thinking", thinking: opts.thinking });
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  for (const call of opts.toolCalls ?? []) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} });
  }
  const msg: AssistantMessage = { role: "assistant", content };
  if (opts.stopReason !== undefined) msg.stopReason = opts.stopReason;
  return msg;
}

export function makeToolResult(opts: {
  id: string;
  isError?: boolean;
  content?: string;
}): ToolResultMessage {
  const msg: ToolResultMessage = {
    role: "toolResult",
    toolCallId: opts.id,
    content: [{ type: "text", text: opts.content ?? "tool output" }],
  };
  if (opts.isError !== undefined) msg.isError = opts.isError;
  return msg;
}

// ── PI event-stream builders ─────────────────────────────────────────

export function makeSessionStart(
  reason: SessionStartReason = "startup",
  previousSessionFile?: string,
): SessionStartEvent {
  const ev: SessionStartEvent = { reason };
  if (previousSessionFile !== undefined) ev.previousSessionFile = previousSessionFile;
  return ev;
}

export function makeMessageEnd(
  message: AgentMessage,
  entryId?: string,
  position?: number,
): MessageEndEvent {
  const ev: MessageEndEvent = { message };
  if (entryId !== undefined) ev.entryId = entryId;
  if (position !== undefined) ev.position = position;
  return ev;
}

export function makeAgentEnd(messages: AgentMessage[]): AgentEndEvent {
  return { messages };
}
