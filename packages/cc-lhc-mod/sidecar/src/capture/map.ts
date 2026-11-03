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

/** A turn's end that recovery reads from the transcript: it settles the state and records nothing. */
export type Settle = { kind: "settle" };

export type Entry = CaptureEntry | Settle;

/**
 * Where the open turn stands, and whether the last user row was a local
 * command's caveat, which Claude Code writes just before a built-in command.
 */
export type TurnState = { isOpen: boolean; step: number | undefined; afterCaveat?: boolean; afterCommand?: boolean };

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

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * Rows a built-in slash command writes around itself: the caveat and its
 * output. The command row alone is kept.
 */
const isCommandNoise = (row: Row): boolean => {
  const text = joinedText(row.message.content).trimStart();
  return (
    text.startsWith("<local-command-caveat>") ||
    text.startsWith("<local-command-stdout>") ||
    text.startsWith("<local-command-stderr>")
  );
};

/** `/name args` for a slash command row, undefined for any other row. */
function slashCommand(row: Row): string | undefined {
  const text = joinedText(row.message.content);
  const name = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (name === undefined) return undefined;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
  return args === undefined || args === "" ? name : `${name} ${args}`;
}

export function isRecorded(row: Row): boolean {
  if (DROPPED_DOORS.has(row.door) || row.message.role === undefined || row.model === "<synthetic>") return false;
  if (isCommandNoise(row)) return false;
  if (row.door === "attachment" || row.door === "hook-context") {
    return row.message.name !== undefined && !MECHANICAL_ATTACHMENTS.has(row.message.name);
  }
  return true;
}

/** The person's own prompt. A background task's notification arrives by the same door and is a note. */
const NOTIFICATION = /<task-notification>[\s\S]*<\/task-notification>/;

/** A background task's notification is not something the person said, whichever door it came by. */
const isTaskNotification = (row: Row): boolean => row.origin === "task-notification";

const isCaveat = (row: Row): boolean => joinedText(row.message.content).trimStart().startsWith("<local-command-caveat>");

/**
 * The person's own request: a submitted prompt, or a slash command that
 * prompts the model (a skill, a plugin or custom command). A built-in local
 * command (/model, /clear) follows its caveat row and is a note.
 */
export const isUserPrompt = (row: Row, afterCaveat = false): boolean =>
  slashCommand(row) === undefined ? row.door === "prompt" && !isTaskNotification(row) : !afterCaveat;

const isPromptCommand = (row: Row, afterCaveat = false): boolean => slashCommand(row) !== undefined && !afterCaveat;

/** The caveat flag after a row: set by a caveat, cleared by any other user row. */
export const caveatAfter = (row: Row, afterCaveat = false): boolean =>
  row.message.type === "user" ? isCaveat(row) : afterCaveat;

export function opensTurn(row: Row, state: TurnState): boolean {
  return isUserPrompt(row, state.afterCaveat) && !state.isOpen;
}

function withStep(events: MessageEventInput[], step: number | undefined): MessageEventInput[] {
  if (step === undefined) return events;
  return events.map((event) =>
    STEP_KINDS.has(event.eventKind) ? ({ ...event, payload: { ...event.payload, stepIndex: step } } as MessageEventInput) : event,
  );
}

const kindlessTextKey = (row: Row): string => idempotencyKey(HARNESS, row.uuid, 0, "text");

function note(row: Row): MessageEventInput[] {
  const joined = joinedText(row.message.content);
  const text = isTaskNotification(row) ? (NOTIFICATION.exec(joined)?.[0] ?? joined) : joined;
  if (text.trim() === "") return [];
  return [textEvent(HARNESS, "runtime_note", text, "system", kindlessTextKey(row))];
}

function prompt(row: Row, isSteer: boolean): MessageEventInput[] {
  const text = slashCommand(row) ?? joinedText(row.message.content);
  const blocks = nonTextBlocks(row.message.content);
  if (text.trim() === "" && blocks === undefined) return [];
  const extra = { ...(isSteer ? { steer: true } : {}), ...(blocks === undefined ? {} : { blocks }) };
  return [textEvent(HARNESS, "user_prompt", text, "user", kindlessTextKey(row), extra)];
}

function mapRow(row: Row, state: TurnState): MessageEventInput[] {
  if (!isRecorded(row)) return [];
  // A prompt command's expanded body (a skill's or custom command's text) follows it as a hidden row.
  if (state.afterCommand === true && row.message.isMeta === true) return [];
  if (isUserPrompt(row, state.afterCaveat)) return prompt(row, state.isOpen);
  const command = slashCommand(row);
  // A typed /compact files its own plain line, recorded as the note; its later command row would be a second.
  if (command === "/compact" || command?.startsWith("/compact ")) return [];
  if (command !== undefined) return [textEvent(HARNESS, "runtime_note", command, "system", kindlessTextKey(row))];
  if (row.message.name === "queued_command" && !isTaskNotification(row)) return prompt(row, true);
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
  entries: readonly Entry[],
  from: TurnState,
): { events: MessageEventInput[]; state: TurnState } {
  const events: MessageEventInput[] = [];
  let state = from;
  for (const entry of entries) {
    switch (entry.kind) {
      case "row":
        events.push(...mapRow(entry, state));
        state = {
          ...state,
          afterCaveat: caveatAfter(entry, state.afterCaveat),
          afterCommand: entry.message.type === "user" ? isPromptCommand(entry, state.afterCaveat) : state.afterCommand === true,
        };
        break;
      case "turn-start":
        state = { ...state, isOpen: true, step: undefined };
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
      case "settle":
        state = SETTLED;
        break;
    }
  }
  return { events, state };
}
