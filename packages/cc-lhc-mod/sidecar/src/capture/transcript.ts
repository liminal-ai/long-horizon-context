import { closeSync, openSync, readSync } from "node:fs";
import type { CapturedMessage } from "../../../src/capture.ts";
import { caveatAfter, type Entry, isUserPrompt, type Row } from "./map.ts";

export type TranscriptLine = {
  uuid: string;
  parentUuid: string | null;
  subtype?: string;
  logicalParentUuid?: string | null;
  type: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  message?: { id?: string; role?: string; content?: unknown; model?: string };
  attachment?: { type?: string; prompt?: unknown; commandMode?: string; origin?: { kind?: string } };
};

const CHUNK = 1 << 20;

export class TranscriptTail {
  readonly parents = new Map<string, string | null>();
  readonly compactBoundaries = new Set<string>();
  readonly prompts = new Set<string>();
  /** The summary and the command rows a native compaction writes after it, which no hook ever sees. */
  readonly compactionRows = new Set<string>();
  readonly #logicalParents = new Map<string, string>();
  #afterCaveat = false;
  #offset: number;
  #pending = Buffer.alloc(0);

  readonly path: string;

  constructor(path: string, offset = 0) {
    this.path = path;
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  /** The live branch: the parent chain from the transcript's last row back to its root, across compactions. */
  activeChain(): Set<string> {
    const chain = new Set<string>();
    let id = [...this.parents.keys()].at(-1);
    while (id !== undefined && !chain.has(id)) {
      chain.add(id);
      id = this.parents.get(id) ?? this.#logicalParents.get(id);
    }
    return chain;
  }

  /**
   * Rows a rewind left: each branch off the active chain that holds a person's
   * prompt, keyed by the chain row it hangs from (null for the root). A branch
   * with no prompt, such as a parallel tool call, is live.
   */
  abandoned(): Map<string | null, string[]> {
    const chain = this.activeChain();
    const children = new Map<string | null, string[]>();
    for (const [child, parent] of this.parents) {
      const siblings = children.get(parent);
      if (siblings === undefined) children.set(parent, [child]);
      else siblings.push(child);
    }
    const subtree = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(subtree)];
    const found = new Map<string | null, string[]>();
    const reachesRoot = this.parents.get([...chain].at(-1) ?? "") === null && !this.compactBoundaries.has([...chain].at(-1) ?? "");
    for (const fork of reachesRoot ? [null, ...chain] : chain) {
      for (const child of children.get(fork) ?? []) {
        if (chain.has(child)) continue;
        const branch = subtree(child);
        if (branch.some((id) => this.prompts.has(id))) found.set(fork, [...(found.get(fork) ?? []), ...branch]);
      }
    }
    return found;
  }

  read(): Array<{ line: TranscriptLine; end: number }> {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines: Array<{ line: TranscriptLine; end: number }> = [];
    try {
      const chunk = Buffer.alloc(CHUNK);
      let position = this.#offset + this.#pending.length;
      for (;;) {
        const n = readSync(fd, chunk, 0, CHUNK, position);
        if (n === 0) break;
        position += n;
        this.#pending = Buffer.concat([this.#pending, chunk.subarray(0, n)]);
        let end = this.#pending.indexOf(10);
        while (end !== -1) {
          const line = parseLine(this.#pending.subarray(0, end).toString("utf8"));
          this.#offset += end + 1;
          this.#pending = this.#pending.subarray(end + 1);
          if (line !== undefined) {
            this.parents.set(line.uuid, line.parentUuid);
            if (line.subtype === "compact_boundary") this.compactBoundaries.add(line.uuid);
            if (typeof line.logicalParentUuid === "string") this.#logicalParents.set(line.uuid, line.logicalParentUuid);
            const isCompactionRow =
              line.isCompactSummary === true ||
              (line.type === "user" &&
                line.origin === undefined &&
                line.parentUuid !== null &&
                this.compactionRows.has(line.parentUuid) &&
                COMMAND_PREFIXES.some((prefix) => textOf(line.message?.content).trimStart().startsWith(prefix)));
            if (isCompactionRow) this.compactionRows.add(line.uuid);
            const row = rowOf(line);
            if (row !== undefined) {
              if (isUserPrompt(row, this.#afterCaveat)) this.prompts.add(line.uuid);
              this.#afterCaveat = caveatAfter(row, this.#afterCaveat);
            }
            lines.push({ line, end: this.#offset });
          }
          end = this.#pending.indexOf(10);
        }
      }
    } finally {
      closeSync(fd);
    }
    return lines;
  }
}

function parseLine(text: string): TranscriptLine | undefined {
  if (text.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const line = value as Partial<TranscriptLine>;
  if (typeof line.uuid !== "string" || typeof line.type !== "string") return undefined;
  return { ...line, uuid: line.uuid, type: line.type, parentUuid: line.parentUuid ?? null };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const first = content.find((block) => (block as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

const COMMAND_PREFIXES = ["<command-", "<local-command-"];

/**
 * The door a live `session.append` would have named for a transcript row. The
 * transcript does not keep an attachment's rendered text, so attachments other
 * than a queued prompt, and notices, are not recoverable and come back undefined.
 */
function doorOf(line: TranscriptLine): string | undefined {
  const content = line.message?.content;
  if (line.type === "assistant") return "response";
  if (line.type !== "user") return undefined;
  if (Array.isArray(content) && content.some((block) => (block as { type?: unknown }).type === "tool_result")) {
    return "tool-result";
  }
  const text = textOf(content).trimStart();
  if (COMMAND_PREFIXES.some((prefix) => text.startsWith(prefix))) return "command";
  // A native /compact files its own line as plain text, by the note door.
  if (line.isMeta === true || text.startsWith("[Request interrupted") || /^\/compact(\s|$)/.test(text)) return "note";
  return "prompt";
}

export function rowOf(line: TranscriptLine): Row | undefined {
  if (line.isSidechain === true || line.isCompactSummary === true) return undefined;
  const origin = line.origin?.kind ?? "unclassified";
  if (line.type === "attachment" && line.attachment?.type === "queued_command") {
    const text = typeof line.attachment.prompt === "string" ? line.attachment.prompt : "";
    const message: CapturedMessage = { type: "attachment", name: "queued_command", role: "user", content: [{ type: "text", text }] };
    const queuedBy = line.attachment.origin?.kind ?? line.attachment.commandMode ?? origin;
    return { kind: "row", sessionId: "", uuid: line.uuid, door: "attachment", origin: queuedBy, message, at: 0 };
  }
  const door = line.message === undefined ? undefined : doorOf(line);
  if (door === undefined || line.message === undefined) return undefined;
  const raw = line.message.content;
  const content = typeof raw === "string" ? [{ type: "text", text: raw }] : Array.isArray(raw) ? raw : [];
  const role = line.type === "assistant" ? "assistant" : "user";
  const message: CapturedMessage = { type: role, role, content, ...(line.isMeta === true ? { isMeta: true as const } : {}) };
  return {
    kind: "row",
    sessionId: "",
    uuid: line.uuid,
    door,
    origin,
    message,
    ...(line.message.model === undefined ? {} : { model: line.message.model }),
    at: 0,
  };
}

/**
 * The entries live capture would have sent for transcript lines: each row past
 * `from`, and, from every line, the turn starts, steps and ends that set the
 * turn state. A prompt opens a turn, each model response (one message id) is
 * one step with its tool results, and a turn's duration row settles it.
 */
export function entriesOf(
  lines: ReadonlyArray<{ line: TranscriptLine; end: number }>,
  skip: (uuid: string) => boolean,
  from: number,
): Entry[] {
  const entries: Entry[] = [];
  let step = -1;
  let response: string | undefined;
  let afterCaveat = false;
  for (const { line, end } of lines) {
    if (line.type === "system" && line.subtype === "turn_duration") {
      entries.push({ kind: "settle" });
      continue;
    }
    const row = skip(line.uuid) ? undefined : rowOf(line);
    if (row === undefined) continue;
    if (line.type === "assistant" && (line.message?.id ?? line.uuid) !== response) {
      response = line.message?.id ?? line.uuid;
      step += 1;
      entries.push({ kind: "step", sessionId: "", turnId: "", index: step, at: 0 });
    }
    if (end > from) entries.push(row);
    if (row.door === "prompt" || isUserPrompt(row, afterCaveat)) {
      entries.push({ kind: "turn-start", sessionId: "", turnId: line.uuid, at: 0 });
      step = -1;
      response = undefined;
    }
    afterCaveat = caveatAfter(row, afterCaveat);
  }
  return entries;
}
