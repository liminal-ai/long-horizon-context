// Recorded-corpus loader (tech design §Fixture Contracts). Each corpus is a
// named recorded PI hook/lifecycle JSONL fixture paired with the LHC intake
// events it should produce. The validator PARSES and CHECKS shapes — it never
// hardcodes a passing count (story §Anti-Shim Requirements).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventKind, MessageEventInput } from "lhc";
import type { AgentMessage } from "../../src/pi/types.js";
import type { Corpus, RecordedPiHookEvent } from "../../src/verify/replay.js";
import { validEvent } from "./synthetic.js";

const CORPUS_DIR = fileURLToPath(new URL("./pi-corpora/", import.meta.url));

type CorpusRecord =
  | { recordType: "pi_hook"; hook: "message_end"; entryId: string; position?: number; message: AgentMessage }
  | { recordType: "pi_lifecycle"; hook: "agent_end"; entryId?: string; position?: number }
  | { recordType: "expected_event"; eventKind: EventKind; payload?: Record<string, unknown> };

function loadRecordedCorpus(name: string): Corpus {
  const source: RecordedPiHookEvent[] = [];
  const expected: MessageEventInput[] = [];
  const path = `${CORPUS_DIR}${name}.jsonl`;
  for (const line of readFileSync(path, "utf8").trim().split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as CorpusRecord;
    if (record.recordType === "pi_hook") {
      if (record.hook !== "message_end") {
        throw new Error(`${name}: pi_hook record must be message_end`);
      }
      const sourceRecord: RecordedPiHookEvent = {
        recordType: "pi_hook",
        hook: "message_end",
        entryId: record.entryId,
        message: record.message,
      };
      if (record.position !== undefined) sourceRecord.position = record.position;
      source.push(sourceRecord);
      continue;
    }
    if (record.recordType === "pi_lifecycle") {
      const sourceRecord: RecordedPiHookEvent = { recordType: "pi_lifecycle", hook: "agent_end" };
      if (record.entryId !== undefined) sourceRecord.entryId = record.entryId;
      if (record.position !== undefined) sourceRecord.position = record.position;
      source.push(sourceRecord);
      continue;
    }
    if (record.recordType !== "expected_event") {
      throw new Error(`${name}: unsupported corpus recordType ${(record as { recordType?: unknown }).recordType}`);
    }
    const overrides = record.payload === undefined ? {} : { payload: record.payload };
    expected.push(validEvent(record.eventKind, overrides as never) as MessageEventInput);
  }
  return { name, source, expected };
}

export const loadChattyCorpus = (): Corpus => loadRecordedCorpus("chatty");
export const loadToolHeavyCorpus = (): Corpus => loadRecordedCorpus("tool-heavy");
export const loadParallelToolCorpus = (): Corpus => loadRecordedCorpus("parallel-tool");
export const loadErrorResultCorpus = (): Corpus => loadRecordedCorpus("error-result");
export const loadAbortedTurnCorpus = (): Corpus => loadRecordedCorpus("aborted-turn");

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
    source: [
      {
        recordType: "pi_hook",
        hook: "message_end",
        entryId: "truncated-entry-0",
        message: { role: "user", content: [{ type: "text", text: "" }], timestamp: 1_700_000_000_000 },
      },
    ],
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

/** Check a corpus yields well-formed recorded hook shapes plus well-formed
 *  `MessageEventInput` expectations, and that the expected lifecycle is coherent
 *  (every `tool_result` correlates to a preceding `tool_call`; the sequence
 *  closes with `turn_end`). Returns the problems it found — `valid` is derived
 *  from that list, never a constant. */
export function validateCorpus(corpus: Corpus): CorpusValidation {
  const problems: string[] = [];
  if (corpus.name.trim() === "") problems.push("corpus has an empty name");
  if (corpus.source.length === 0) problems.push(`${corpus.name}: no recorded PI hook events`);
  if (corpus.expected.length === 0) problems.push(`${corpus.name}: no expected events`);

  for (const [i, source] of corpus.source.entries()) {
    const at = `${corpus.name}.source[${i}]`;
    if (source.hook === "message_end") {
      if (source.recordType !== "pi_hook") problems.push(`${at}: message_end must be a pi_hook record`);
      if (source.entryId.trim() === "") problems.push(`${at}: empty entryId`);
      if (
        source.message.role !== "user" &&
        source.message.role !== "assistant" &&
        source.message.role !== "toolResult"
      ) {
        problems.push(`${at}: unsupported message role`);
      }
    } else if (source.hook === "agent_end") {
      if (source.recordType !== "pi_lifecycle") problems.push(`${at}: agent_end must be a pi_lifecycle record`);
    } else {
      problems.push(`${at}: unsupported hook`);
    }
  }

  const seenToolCalls = new Set<string>();
  for (const [i, ev] of corpus.expected.entries()) {
    const at = `${corpus.name}.expected[${i}]`;
    if (!EVENT_KINDS.has(ev.eventKind)) problems.push(`${at}: unknown eventKind "${String(ev.eventKind)}"`);
    if (typeof ev.idempotencyKey !== "string" || ev.idempotencyKey === "") problems.push(`${at}: empty idempotencyKey`);
    if (typeof ev.actor !== "string" || ev.actor === "") problems.push(`${at}: empty actor`);
    if (typeof ev.harness !== "string" || ev.harness === "") problems.push(`${at}: empty harness`);

    switch (ev.eventKind) {
      case "user_prompt":
      case "assistant_thinking":
      case "runtime_note": {
        if (typeof ev.payload.text !== "string" || ev.payload.text === "") {
          problems.push(`${at}: ${ev.eventKind} has empty text`);
        }
        break;
      }
      case "assistant_text": {
        if (typeof ev.payload.text !== "string" || ev.payload.text === "") {
          problems.push(`${at}: ${ev.eventKind} has empty text`);
        }
        // Optional schema-v5 providerUsage: when present, must be a plain object.
        if ("providerUsage" in ev.payload && ev.payload.providerUsage !== undefined) {
          const usage = ev.payload.providerUsage;
          if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
            problems.push(`${at}: assistant_text.providerUsage must be a plain object when present`);
          }
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
      case "turn_end": {
        // Optional schema-v5 host facts: when present, check closed shape.
        const p = ev.payload;
        if (p.outcome !== undefined && p.outcome !== "completed" && p.outcome !== "aborted") {
          problems.push(`${at}: turn_end.outcome must be "completed" | "aborted" when present`);
        }
        if (p.outcomeReason !== undefined && typeof p.outcomeReason !== "string") {
          problems.push(`${at}: turn_end.outcomeReason must be a string when present`);
        }
        if (p.startedAt !== undefined && typeof p.startedAt !== "string") {
          problems.push(`${at}: turn_end.startedAt must be a string when present`);
        }
        if (p.endedAt !== undefined && typeof p.endedAt !== "string") {
          problems.push(`${at}: turn_end.endedAt must be a string when present`);
        }
        break;
      }
    }
  }

  const last = corpus.expected[corpus.expected.length - 1];
  if (last !== undefined && last.eventKind !== "turn_end") {
    problems.push(`${corpus.name}: sequence does not close with turn_end`);
  }
  const lastSource = corpus.source[corpus.source.length - 1];
  if (lastSource !== undefined && lastSource.hook !== "agent_end") {
    problems.push(`${corpus.name}: recorded PI lifecycle does not close with agent_end`);
  }

  return { valid: problems.length === 0, problems };
}
