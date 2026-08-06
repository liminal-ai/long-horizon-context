// Synthetic builders for the two test edges (tech design §Fixture Contracts):
//   - PI `AgentMessage` / event builders feed the PI hook edge where a precise
//     hand-built shape beats a recorded one (lifecycle + turn-derivation tests).
//   - `validEvent` builds a single, correctly-typed LHC `MessageEventInput` so
//     a kind/payload mismatch is a compile error, not a runtime surprise.
import type { EventKind, MessageEventInput } from "lhc";
import type {
  AgentEndEvent,
  AgentMessage,
  AgentSettledEvent,
  AssistantMessage,
  ContentPart,
  MessageEndEvent,
  ModelSelectEvent,
  PiStopReason,
  SessionStartEvent,
  SessionStartReason,
  ThinkingLevelSelectEvent,
  ToolResultMessage,
  Usage,
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
  model_change: () => ({ previousModel: "anthropic/claude", newModel: "openai/gpt" }),
  thinking_level_change: () => ({ previousLevel: "medium", newLevel: "high" }),
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

/** Fixed default epoch so builders stay deterministic for replay/timing tests. */
export const FIXTURE_TIMESTAMP_MS = 1_700_000_000_000;

export function zeroUsage(overrides: Partial<Usage> = {}): Usage {
  const baseCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input: overrides.input ?? 0,
    output: overrides.output ?? 0,
    cacheRead: overrides.cacheRead ?? 0,
    cacheWrite: overrides.cacheWrite ?? 0,
    totalTokens: overrides.totalTokens ?? 0,
    cost: { ...baseCost, ...overrides.cost },
    ...(overrides.cacheWrite1h !== undefined ? { cacheWrite1h: overrides.cacheWrite1h } : {}),
    ...(overrides.reasoning !== undefined ? { reasoning: overrides.reasoning } : {}),
  };
}

export function makeUserMessage(text = "please read the file", timestamp = FIXTURE_TIMESTAMP_MS): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

export interface AssistantToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MakeAssistantMessageOpts {
  thinking?: string;
  /** Opaque provider token on the thinking part (PI thinkingSignature). */
  thinkingSignature?: string;
  text?: string;
  toolCalls?: AssistantToolCall[];
  stopReason?: PiStopReason;
  errorMessage?: string;
  usage?: Usage;
  timestamp?: number;
  provider?: string;
  model?: string;
  responseId?: string;
}

/** Fans out to content parts in PI's confirmed order: thinking → text →
 *  toolCall×N (research §5a). Always supplies PI-required fields (timestamp,
 *  stopReason, provider, model, usage) so typed tests match the real wire. */
export function makeAssistantMessage(opts: MakeAssistantMessageOpts = {}): AssistantMessage {
  const content: ContentPart[] = [];
  if (opts.thinking !== undefined || opts.thinkingSignature !== undefined) {
    const thinking: Extract<ContentPart, { type: "thinking" }> = {
      type: "thinking",
      thinking: opts.thinking ?? "",
    };
    if (opts.thinkingSignature !== undefined) thinking.thinkingSignature = opts.thinkingSignature;
    content.push(thinking);
  }
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  for (const call of opts.toolCalls ?? []) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments ?? {} });
  }
  const msg: AssistantMessage = {
    role: "assistant",
    content,
    provider: opts.provider ?? "test",
    model: opts.model ?? "test-model",
    usage: opts.usage ?? zeroUsage(),
    stopReason: opts.stopReason ?? "stop",
    timestamp: opts.timestamp ?? FIXTURE_TIMESTAMP_MS,
  };
  if (opts.errorMessage !== undefined) msg.errorMessage = opts.errorMessage;
  if (opts.responseId !== undefined) msg.responseId = opts.responseId;
  return msg;
}

export function makeToolResult(opts: {
  id: string;
  isError?: boolean;
  content?: string;
  timestamp?: number;
  toolName?: string;
}): ToolResultMessage {
  const msg: ToolResultMessage = {
    role: "toolResult",
    toolCallId: opts.id,
    content: [{ type: "text", text: opts.content ?? "tool output" }],
    timestamp: opts.timestamp ?? FIXTURE_TIMESTAMP_MS,
  };
  if (opts.isError !== undefined) msg.isError = opts.isError;
  if (opts.toolName !== undefined) msg.toolName = opts.toolName;
  return msg;
}

// ── PI event-stream builders ─────────────────────────────────────────

export function makeSessionStart(
  reason: SessionStartReason = "startup",
  previousSessionFile?: string,
): SessionStartEvent {
  const ev: SessionStartEvent = { type: "session_start", reason };
  if (previousSessionFile !== undefined) ev.previousSessionFile = previousSessionFile;
  return ev;
}

export function makeMessageEnd(message: AgentMessage, _entryId?: string, _position?: number): MessageEndEvent {
  const event = { type: "message_end", message } as MessageEndEvent & { entryId?: string; position?: number };
  if (_entryId !== undefined) event.entryId = _entryId;
  if (_position !== undefined) event.position = _position;
  return event;
}

export function makeAgentEnd(messages: AgentMessage[]): AgentEndEvent {
  return { type: "agent_end", messages };
}

export function makeAgentSettled(): AgentSettledEvent {
  return { type: "agent_settled" };
}

export function makeModelSelect(
  model: { provider: string; id: string },
  previousModel?: { provider: string; id: string },
): ModelSelectEvent {
  const event: ModelSelectEvent = { type: "model_select", model };
  if (previousModel !== undefined) event.previousModel = previousModel;
  return event;
}

export function makeThinkingLevelSelect(level: string, previousLevel: string): ThinkingLevelSelectEvent {
  return { type: "thinking_level_select", level, previousLevel };
}
