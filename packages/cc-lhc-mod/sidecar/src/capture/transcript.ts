import { closeSync, openSync, readSync } from "node:fs";
import type { CapturedMessage } from "../../../src/capture.ts";
import type { Row } from "./map.ts";

export type TranscriptLine = {
  uuid: string;
  parentUuid: string | null;
  type: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  message?: { role?: string; content?: unknown; model?: string };
  attachment?: { type?: string; prompt?: unknown };
};

const CHUNK = 1 << 20;

export class TranscriptTail {
  readonly parents = new Map<string, string | null>();
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

const NOTE_PREFIXES = ["[Request interrupted", "<command-", "<local-command-"];

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
  if (line.isMeta === true || NOTE_PREFIXES.some((prefix) => text.startsWith(prefix))) return "note";
  return "prompt";
}

export function rowOf(line: TranscriptLine): Row | undefined {
  if (line.isSidechain === true || line.isCompactSummary === true) return undefined;
  const origin = line.origin?.kind ?? "human";
  if (line.type === "attachment" && line.attachment?.type === "queued_command") {
    const text = typeof line.attachment.prompt === "string" ? line.attachment.prompt : "";
    const message: CapturedMessage = { type: "attachment", name: "queued_command", role: "user", content: [{ type: "text", text }] };
    return { kind: "row", sessionId: "", uuid: line.uuid, door: "attachment", origin, message, at: 0 };
  }
  const door = line.message === undefined ? undefined : doorOf(line);
  if (door === undefined || line.message === undefined) return undefined;
  const raw = line.message.content;
  const content = typeof raw === "string" ? [{ type: "text", text: raw }] : Array.isArray(raw) ? raw : [];
  const role = line.type === "assistant" ? "assistant" : "user";
  const message: CapturedMessage = { type: role, role, content };
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
