import {
  idempotencyKey,
  joinedText,
  mapAssistantBlocks,
  mapUserBlocks,
  nonTextBlocks,
  textEvent,
} from "claude-adapter";
import type { MessageEventInput } from "lhc";
import type { CaptureEntry } from "../../../src/capture.ts";

export const HARNESS = "claude-code";

export type Row = Extract<CaptureEntry, { kind: "row" }>;

export type TurnState = { isOpen: boolean; step: number | undefined };

export const SETTLED: TurnState = { isOpen: false, step: undefined };

/** Context Claude Code injects beside the conversation on every request or turn, not part of the exchange. */
const MECHANICAL_ATTACHMENTS = new Set([
  "agent_listing_delta",
  "auto_mode",
  "date",
  "deferred_tools_delta",
  "environment",
  "hook_success",
  "instructions",
  "mcp_instructions_delta",
  "model",
  "nested_memory",
  "output_style",
  "output_style_instructions",
  "plan_mode",
  "prompt_snapshot",
  "read_truncation_notice",
  "remote_session_change",
  "session_context",
  "skill_listing",
]);

const STEP_KINDS = new Set(["assistant_text", "assistant_thinking", "tool_call", "tool_result"]);

const DROPPED_DOORS = new Set(["queue", "compaction", "notice"]);

export function isRecorded(row: Row): boolean {
  if (DROPPED_DOORS.has(row.door) || row.message.role === undefined || row.model === "<synthetic>") return false;
  if (row.door === "attachment" || row.door === "hook-context") {
    return row.message.name !== undefined && !MECHANICAL_ATTACHMENTS.has(row.message.name);
  }
  return true;
}

/** The person's own prompt. A background task's notification arrives by the same door and is a note. */
const isUserPrompt = (row: Row): boolean => row.door === "prompt" && row.origin !== "task-notification";

export function opensTurn(row: Row, state: TurnState): boolean {
  return isUserPrompt(row) && !state.isOpen;
}

function withStep(events: MessageEventInput[], step: number | undefined): MessageEventInput[] {
  if (step === undefined) return events;
  return events.map((event) =>
    STEP_KINDS.has(event.eventKind) ? ({ ...event, payload: { ...event.payload, stepIndex: step } } as MessageEventInput) : event,
  );
}

const kindlessTextKey = (row: Row): string => idempotencyKey(HARNESS, row.uuid, 0, "text");

function note(row: Row): MessageEventInput[] {
  const text = joinedText(row.message.content);
  if (text.trim() === "") return [];
  return [textEvent(HARNESS, "runtime_note", text, "system", kindlessTextKey(row))];
}

function prompt(row: Row, isSteer: boolean): MessageEventInput[] {
  const text = joinedText(row.message.content);
  const blocks = nonTextBlocks(row.message.content);
  if (text.trim() === "" && blocks === undefined) return [];
  const extra = { ...(isSteer ? { steer: true } : {}), ...(blocks === undefined ? {} : { blocks }) };
  return [textEvent(HARNESS, "user_prompt", text, "user", kindlessTextKey(row), extra)];
}

function mapRow(row: Row, state: TurnState): MessageEventInput[] {
  if (!isRecorded(row)) return [];
  if (isUserPrompt(row)) return prompt(row, state.isOpen);
  if (row.message.name === "queued_command") return prompt(row, true);
  switch (row.door) {
    case "response":
      return withStep(mapAssistantBlocks(HARNESS, row.uuid, { content: row.message.content, model: row.model }), state.step);
    case "tool-result":
    case "tool-message":
      return withStep(mapUserBlocks(HARNESS, row.uuid, row.message.content), state.step);
    default:
      return note(row);
  }
}

export function mapEntries(
  entries: readonly CaptureEntry[],
  from: TurnState,
): { events: MessageEventInput[]; state: TurnState } {
  const events: MessageEventInput[] = [];
  let state = from;
  for (const entry of entries) {
    switch (entry.kind) {
      case "row":
        events.push(...mapRow(entry, state));
        break;
      case "turn-start":
        state = { isOpen: true, step: undefined };
        break;
      case "step":
        state = { ...state, step: entry.index };
        break;
      case "turn-end":
        events.push({
          eventKind: "turn_end",
          idempotencyKey: `${HARNESS}:turn:${entry.turnId}:turn_end`,
          actor: "system",
          harness: HARNESS,
          payload: { outcome: entry.isAborted ? "aborted" : "completed", outcomeReason: entry.reason },
        });
        state = SETTLED;
        break;
    }
  }
  return { events, state };
}
