/**
 * Native Claude Agent SDK wire messages → LHC intake events.
 *
 * Pure: messages in, events out. Rules follow cc-lhc's calibrated rollout mapper
 * (one event per content block in native order, block-indexed idempotency keys,
 * verbatim provider usage, opaque thinking signatures, subagent sidechains
 * skipped) applied to the SDK stream instead of the file.
 *
 * Content blocks beyond text (images, documents, redacted thinking, server-side
 * tool blocks) ride verbatim: a prompt or tool result that carries any non-text
 * block sends the whole native content array as `blocks` (LHC moves the bytes to
 * its blob table and keeps the block shape); `redacted_thinking` and
 * `server_tool_use` ride as `block` on their thinking / tool_call event; the
 * server-side *_tool_result blocks inside an assistant message are tool_result
 * events carrying the block, paired by tool_use_id like any other result.
 *
 * The user's prompt is not mapped from the wire: the session records it at the
 * moment it hands the prompt to the SDK (see `mapPrompt`), which is the model-visible
 * seam; the SDK does not echo it back. Wire `user` frames are therefore tool results
 * or text the CLI injected itself (task notifications, hook output), which is recorded
 * as a runtime note so it never opens a turn. Replays on resume are skipped.
 */
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ApiBlock, MessageEventInput } from "lhc";

export const HARNESS = "claude-lhc";
const TASK_NOTIFICATION_MARKER = "<task-notification>";
const RUNTIME_NOTE_LABEL = "[runtime note]";
const STEER_LABEL = "[user steer]";
const SYNTHETIC_MODEL = "<synthetic>";

export interface AssistantProvenance {
  provider: string;
  api: string;
}
export const CLAUDE_PROVENANCE: AssistantProvenance = { provider: "anthropic", api: "messages" };

export function idempotencyKey(uuid: string, blockIndex: number, kind: string): string {
  return `claude-lhc:${uuid}:${blockIndex}:${kind}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocks(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

const SERVER_RESULT_TYPES = new Set([
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
]);

/** The native content array when any block is not text; undefined for text-only content. */
function nonTextBlocks(content: unknown): ApiBlock[] | undefined {
  const parts = blocks(content).filter((b): b is ApiBlock => typeof b["type"] === "string");
  return parts.some((b) => b.type !== "text") ? parts : undefined;
}

function joinedText(content: unknown): string {
  return blocks(content).filter((b) => b["type"] === "text").map((b) => (typeof b["text"] === "string" ? b["text"] : "")).join("");
}

export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && typeof block["text"] === "string" ? block["text"] : JSON.stringify(block)))
      .join("\n");
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

function text(kind: "user_prompt" | "assistant_text" | "assistant_thinking" | "runtime_note", body: string, actor: string, key: string, extra: Record<string, unknown> = {}): MessageEventInput {
  return { eventKind: kind, idempotencyKey: key, actor, harness: HARNESS, payload: { text: body, ...extra } } as MessageEventInput;
}

/** Text of a prompt: its text blocks joined. Attached images and documents ride as `blocks`. */
export function promptText(message: SDKUserMessage): string {
  return joinedText(message.message.content);
}

/** `/compact [args]` as the whole prompt → the manual compact command. */
export function compactCommand(message: SDKUserMessage): { args: string } | null {
  const body = promptText(message).trim();
  if (body !== "/compact" && !body.startsWith("/compact ")) return null;
  return { args: body.slice("/compact".length).trim() };
}

/**
 * The prompt the session is about to hand the SDK. A machine prompt (task
 * notification, re-served runtime note) is a runtime note; a prompt landing in an
 * open turn is a steer and joins that turn as a labelled runtime note (main LHC has
 * no user_steer kind); anything else is the user's prompt.
 */
export function mapPrompt(message: SDKUserMessage, uuid: string, turnOpen: boolean): MessageEventInput[] {
  const body = promptText(message);
  if (body === "" && nonTextBlocks(message.message.content) === undefined) return [];
  const trimmed = body.trimStart();
  if (trimmed.startsWith(TASK_NOTIFICATION_MARKER)) return [text("runtime_note", body, "system", idempotencyKey(uuid, 0, "runtime_note"))];
  if (trimmed.startsWith(RUNTIME_NOTE_LABEL)) {
    const stripped = trimmed.slice(RUNTIME_NOTE_LABEL.length).replace(/^ /, "");
    return [text("runtime_note", stripped, "system", idempotencyKey(uuid, 0, "runtime_note"))];
  }
  if (turnOpen) return [text("runtime_note", `${STEER_LABEL} ${body}`, "user", idempotencyKey(uuid, 0, "runtime_note"))];
  const attached = nonTextBlocks(message.message.content);
  return [text("user_prompt", body, "user", idempotencyKey(uuid, 0, "user_prompt"), attached === undefined ? {} : { blocks: attached })];
}

export interface MapResult {
  events: MessageEventInput[];
  /** True when this message ends the agentic turn (SDK `result`). */
  turnEnd: boolean;
  /** Provider-reported input context (input + cache creation + cache read) when the message carries usage. */
  contextTokens?: number;
}

function usageContextTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const n = (k: string): number => (typeof usage[k] === "number" && Number.isFinite(usage[k]) ? (usage[k] as number) : 0);
  const total = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
  return total > 0 ? total : undefined;
}

export function mapSdkMessage(message: SDKMessage, turnStartedAt: string | undefined): MapResult {
  const none: MapResult = { events: [], turnEnd: false };
  const m = message as unknown as Record<string, unknown>;
  const uuid = typeof m["uuid"] === "string" ? m["uuid"] : undefined;

  if (message.type === "assistant") {
    if (message.parent_tool_use_id !== null) return none; // subagent sidechain
    const inner = message.message as unknown as Record<string, unknown>;
    const model = typeof inner["model"] === "string" ? inner["model"] : undefined;
    if (model === SYNTHETIC_MODEL) return none;
    const providerUsage = isRecord(inner["usage"]) ? inner["usage"] : undefined;
    const events: MessageEventInput[] = [];
    const id = uuid ?? `assistant:${String(inner["id"])}`;
    const provenance = { ...CLAUDE_PROVENANCE, ...(model !== undefined ? { model } : {}) };
    for (const [index, block] of blocks(inner["content"]).entries()) {
      if (block["type"] === "thinking") {
        const signature = typeof block["signature"] === "string" ? block["signature"] : "";
        events.push(text("assistant_thinking", typeof block["thinking"] === "string" ? block["thinking"] : "", "assistant", idempotencyKey(id, index, "assistant_thinking"), {
          ...(signature !== "" ? { signature } : {}), ...provenance,
        }));
      } else if (block["type"] === "redacted_thinking") {
        events.push(text("assistant_thinking", "", "assistant", idempotencyKey(id, index, "assistant_thinking"), { block, ...provenance }));
      } else if (block["type"] === "server_tool_use") {
        events.push({
          eventKind: "tool_call", idempotencyKey: idempotencyKey(id, index, "tool_call"), actor: "assistant", harness: HARNESS,
          payload: { toolCallId: String(block["id"]), toolName: String(block["name"]), arguments: isRecord(block["input"]) ? block["input"] : {}, block: block as ApiBlock },
        });
      } else if (typeof block["type"] === "string" && SERVER_RESULT_TYPES.has(block["type"])) {
        events.push({
          eventKind: "tool_result", idempotencyKey: idempotencyKey(id, index, "tool_result"), actor: "tool", harness: HARNESS,
          payload: { toolCallId: String(block["tool_use_id"]), content: "", isError: isRecord(block["content"]) && typeof block["content"]["error_code"] === "string", blocks: [block as ApiBlock] },
        });
      } else if (block["type"] === "text") {
        const body = typeof block["text"] === "string" ? block["text"] : "";
        if (body === "") continue;
        events.push(text("assistant_text", body, "assistant", idempotencyKey(id, index, "assistant_text"), {
          ...(providerUsage !== undefined ? { providerUsage } : {}), ...provenance,
        }));
      } else if (block["type"] === "tool_use") {
        events.push({
          eventKind: "tool_call", idempotencyKey: idempotencyKey(id, index, "tool_call"), actor: "assistant", harness: HARNESS,
          payload: { toolCallId: String(block["id"]), toolName: String(block["name"]), arguments: isRecord(block["input"]) ? block["input"] : {} },
        });
      }
    }
    const contextTokens = usageContextTokens(providerUsage);
    return { events, turnEnd: false, ...(contextTokens !== undefined ? { contextTokens } : {}) };
  }

  if (message.type === "user") {
    if (message.parent_tool_use_id !== null) return none;
    if (m["isReplay"] === true) return none;
    const events: MessageEventInput[] = [];
    const id = uuid ?? `user:${Date.now()}`;
    for (const [index, block] of blocks(message.message.content).entries()) {
      if (block["type"] === "tool_result") {
        // A result carrying images or documents (Read on a PNG or PDF) sends the
        // native content array; text-only results stay a string.
        const attached = nonTextBlocks(block["content"]);
        events.push({
          eventKind: "tool_result", idempotencyKey: idempotencyKey(id, index, "tool_result"), actor: "tool", harness: HARNESS,
          payload: {
            toolCallId: String(block["tool_use_id"]), isError: block["is_error"] === true,
            content: attached === undefined ? stringifyToolResultContent(block["content"]) : joinedText(block["content"]),
            ...(attached === undefined ? {} : { blocks: attached }),
          },
        });
      } else if (block["type"] === "text") {
        const body = typeof block["text"] === "string" ? block["text"] : "";
        if (body === "") continue;
        events.push(text("runtime_note", body, "system", idempotencyKey(id, index, "runtime_note")));
      }
    }
    return { events, turnEnd: false };
  }

  if (message.type === "result") {
    const aborted = message.subtype !== "success" || message.is_error === true;
    const id = uuid ?? `result:${Date.now()}`;
    const endedAt = new Date().toISOString();
    return {
      events: [{
        eventKind: "turn_end", idempotencyKey: idempotencyKey(id, 0, "turn_end"), actor: "system", harness: HARNESS,
        payload: {
          outcome: aborted ? "aborted" : "completed",
          outcomeReason: message.subtype,
          ...(turnStartedAt !== undefined ? { startedAt: turnStartedAt } : {}),
          endedAt,
        },
      }],
      turnEnd: true,
    };
  }

  return none;
}
