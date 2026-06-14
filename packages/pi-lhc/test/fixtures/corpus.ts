// Recorded-corpus loader (tech design §Fixture Contracts). Each corpus is a
// named lifecycle paired with the LHC intake events it should produce. Until M0
// delivers real recordings, the loaders build synthetic stand-ins; the
// machinery (load → validate shape → compare on replay in Story 3) is real and
// widens as corpora arrive. The validator PARSES and CHECKS shapes — it never
// hardcodes a passing count (story §Anti-Shim Requirements).
import type { EventKind } from "lhc";
import type { Corpus } from "../../src/verify/replay.js";
import { ABORTED_DISPOSITION_TEXT } from "../../src/capture/map-message.js";
import {
  makeAssistantMessage,
  makeToolResult,
  makeUserMessage,
  validEvent,
} from "./synthetic.js";

const CALL_A = "call_a|fc_1";
const CALL_B = "call_b|fc_2";

/** Plain user/assistant text exchanges, no tools. */
export function loadChattyCorpus(): Corpus {
  return {
    name: "chatty",
    source: [
      makeUserMessage("what does this repo do?"),
      makeAssistantMessage({ text: "it is the LHC SDK" }),
      makeUserMessage("and the connector?"),
      makeAssistantMessage({ text: "it wires PI to LHC" }),
    ],
    expected: [
      validEvent("user_prompt", { payload: { text: "what does this repo do?" } }),
      validEvent("assistant_text", { payload: { text: "it is the LHC SDK" } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "and the connector?" } }),
      validEvent("assistant_text", { payload: { text: "it wires PI to LHC" } }),
      validEvent("turn_end"),
    ],
  };
}

/** One turn with a single tool run: thinking → call → result → answer. */
export function loadToolHeavyCorpus(): Corpus {
  return {
    name: "tool-heavy",
    source: [
      makeUserMessage("read notes.txt"),
      makeAssistantMessage({
        thinking: "I should open the file",
        toolCalls: [{ id: CALL_A, name: "read_file", arguments: { path: "notes.txt" } }],
      }),
      makeToolResult({ id: CALL_A, content: "contents of notes.txt" }),
      makeAssistantMessage({ text: "the file says hello" }),
    ],
    expected: [
      validEvent("user_prompt", { payload: { text: "read notes.txt" } }),
      validEvent("assistant_thinking", { payload: { text: "I should open the file" } }),
      validEvent("tool_call", {
        payload: { toolCallId: CALL_A, toolName: "read_file", arguments: { path: "notes.txt" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: CALL_A, content: "contents of notes.txt", isError: false } }),
      validEvent("assistant_text", { payload: { text: "the file says hello" } }),
      validEvent("turn_end"),
    ],
  };
}

/** Two parallel tool calls whose results complete out of order; correlation is
 *  by id, not arrival order (AC-2.3). */
export function loadParallelToolCorpus(): Corpus {
  return {
    name: "parallel-tool",
    source: [
      makeUserMessage("read both files"),
      makeAssistantMessage({
        toolCalls: [
          { id: CALL_A, name: "read_file", arguments: { path: "a.txt" } },
          { id: CALL_B, name: "read_file", arguments: { path: "b.txt" } },
        ],
      }),
      makeToolResult({ id: CALL_B, content: "b contents" }),
      makeToolResult({ id: CALL_A, content: "a contents" }),
      makeAssistantMessage({ text: "read both" }),
    ],
    expected: [
      validEvent("user_prompt", { payload: { text: "read both files" } }),
      validEvent("tool_call", { payload: { toolCallId: CALL_A, toolName: "read_file", arguments: { path: "a.txt" } } }),
      validEvent("tool_call", { payload: { toolCallId: CALL_B, toolName: "read_file", arguments: { path: "b.txt" } } }),
      validEvent("tool_result", { payload: { toolCallId: CALL_B, content: "b contents", isError: false } }),
      validEvent("tool_result", { payload: { toolCallId: CALL_A, content: "a contents", isError: false } }),
      validEvent("assistant_text", { payload: { text: "read both" } }),
      validEvent("turn_end"),
    ],
  };
}

/** A tool result flagged as an error, captured with its content (AC-2.4). */
export function loadErrorResultCorpus(): Corpus {
  return {
    name: "error-result",
    source: [
      makeUserMessage("read missing.txt"),
      makeAssistantMessage({ toolCalls: [{ id: CALL_A, name: "read_file", arguments: { path: "missing.txt" } }] }),
      makeToolResult({ id: CALL_A, isError: true, content: "ENOENT: no such file" }),
      makeAssistantMessage({ text: "that file does not exist" }),
    ],
    expected: [
      validEvent("user_prompt", { payload: { text: "read missing.txt" } }),
      validEvent("tool_call", { payload: { toolCallId: CALL_A, toolName: "read_file", arguments: { path: "missing.txt" } } }),
      validEvent("tool_result", { payload: { toolCallId: CALL_A, content: "ENOENT: no such file", isError: true } }),
      validEvent("assistant_text", { payload: { text: "that file does not exist" } }),
      validEvent("turn_end"),
    ],
  };
}

/** A graceful interrupt: partial assistant content, turn closed
 *  complete-but-aborted at agent_end (AC-2.6 / research §5b). */
export function loadAbortedTurnCorpus(): Corpus {
  return {
    name: "aborted-turn",
    source: [
      makeUserMessage("write a long essay"),
      makeAssistantMessage({ thinking: "starting the essay", text: "Once upon a", stopReason: "aborted" }),
    ],
    expected: [
      validEvent("user_prompt", { payload: { text: "write a long essay" } }),
      validEvent("assistant_thinking", { payload: { text: "starting the essay" } }),
      validEvent("assistant_text", { payload: { text: "Once upon a" } }),
      // The aborted disposition rides a trailing runtime_note (the mapper carries
      // stopReason through; research §5b), then the turn closes complete-but-aborted.
      validEvent("runtime_note", { payload: { text: ABORTED_DISPOSITION_TEXT } }),
      validEvent("turn_end"),
    ],
  };
}

export const CORPUS_LOADERS = {
  chatty: loadChattyCorpus,
  "tool-heavy": loadToolHeavyCorpus,
  "parallel-tool": loadParallelToolCorpus,
  "error-result": loadErrorResultCorpus,
  "aborted-turn": loadAbortedTurnCorpus,
} as const;

export type CorpusName = keyof typeof CORPUS_LOADERS;

export function loadAllCorpora(): Corpus[] {
  return Object.values(CORPUS_LOADERS).map((load) => load());
}

/** A deliberately malformed sequence for the capture-failure test: an empty
 *  user prompt, a `tool_result` whose id has no preceding `tool_call` (dangling
 *  correlation), and no closing `turn_end`. `validateCorpus` must reject it —
 *  proving the validator actually inspects shape rather than rubber-stamping. */
export function makeTruncatedCorpus(): Corpus {
  return {
    name: "truncated",
    source: [makeUserMessage("")],
    expected: [
      validEvent("user_prompt", { payload: { text: "" } }),
      validEvent("tool_result", { payload: { toolCallId: "dangling-call", content: "orphan result", isError: false } }),
    ],
  };
}

export interface CorpusValidation {
  valid: boolean;
  problems: string[];
}

const EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "runtime_note",
  "tool_call",
  "tool_result",
  "turn_end",
]);

/** Check a corpus yields well-formed `MessageEventInput` shapes and a
 *  lifecycle-coherent sequence (every `tool_result` correlates to a preceding
 *  `tool_call`; the sequence closes with `turn_end`). Returns the problems it
 *  found — `valid` is derived from that list, never a constant. */
export function validateCorpus(corpus: Corpus): CorpusValidation {
  const problems: string[] = [];
  if (corpus.name.trim() === "") problems.push("corpus has an empty name");
  if (corpus.expected.length === 0) problems.push(`${corpus.name}: no expected events`);

  const seenToolCalls = new Set<string>();
  for (const [i, ev] of corpus.expected.entries()) {
    const at = `${corpus.name}[${i}]`;
    if (!EVENT_KINDS.has(ev.eventKind)) problems.push(`${at}: unknown eventKind "${String(ev.eventKind)}"`);
    if (typeof ev.idempotencyKey !== "string" || ev.idempotencyKey === "") problems.push(`${at}: empty idempotencyKey`);
    if (typeof ev.actor !== "string" || ev.actor === "") problems.push(`${at}: empty actor`);
    if (typeof ev.harness !== "string" || ev.harness === "") problems.push(`${at}: empty harness`);

    switch (ev.eventKind) {
      case "user_prompt":
      case "assistant_text":
      case "assistant_thinking":
      case "runtime_note": {
        if (typeof ev.payload.text !== "string" || ev.payload.text === "") {
          problems.push(`${at}: ${ev.eventKind} has empty text`);
        }
        break;
      }
      case "tool_call": {
        if (typeof ev.payload.toolCallId !== "string" || ev.payload.toolCallId === "") {
          problems.push(`${at}: tool_call has empty toolCallId`);
        } else {
          seenToolCalls.add(ev.payload.toolCallId);
        }
        if (typeof ev.payload.toolName !== "string" || ev.payload.toolName === "") {
          problems.push(`${at}: tool_call has empty toolName`);
        }
        break;
      }
      case "tool_result": {
        if (typeof ev.payload.toolCallId !== "string" || ev.payload.toolCallId === "") {
          problems.push(`${at}: tool_result has empty toolCallId`);
        } else if (!seenToolCalls.has(ev.payload.toolCallId)) {
          problems.push(`${at}: tool_result for "${ev.payload.toolCallId}" has no preceding tool_call`);
        }
        if (typeof ev.payload.content !== "string") {
          problems.push(`${at}: tool_result has non-string content`);
        }
        break;
      }
      case "turn_end":
        break;
    }
  }

  const last = corpus.expected[corpus.expected.length - 1];
  if (last !== undefined && last.eventKind !== "turn_end") {
    problems.push(`${corpus.name}: sequence does not close with turn_end`);
  }

  return { valid: problems.length === 0, problems };
}
