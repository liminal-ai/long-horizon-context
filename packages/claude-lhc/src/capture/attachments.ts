import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { nativeSessionPath } from "../nativeSessionFile.js";
import { anchorOf, type NativeEntry, PROJECTED_SOURCE_FIELD, type ProjectedAttachment } from "../projection/project.js";
import { messageKeyPrefix } from "./mapper.js";

// The CLI sends a stored attachment line's `rendered` text and re-renders only when it is missing.
const RESTAMPED_FIELDS = new Set([
  "parentUuid",
  "isSidechain",
  "userType",
  "entrypoint",
  "cwd",
  "sessionId",
  "version",
  "gitBranch",
  "timestamp",
  "uuid",
]);

export interface StoredAttachment extends ProjectedAttachment {
  readonly anchor: string;
}

export interface AttachmentSource {
  readonly home: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export function attachmentStorePath(home: string, threadId: string): string {
  return NodePath.join(home, "attachments", `${threadId}.jsonl`);
}

export interface Harvest {
  readonly found: number;
  readonly bytesRead: number;
}

interface ChainLine {
  readonly type: unknown;
  readonly parent: unknown;
  readonly source: unknown;
}

interface TranscriptCursor {
  offset: number;
  readonly lines: Map<string, ChainLine>;
}

interface HeldAttachments {
  readonly uuids: Set<string>;
  torn: boolean;
}

// One per process. A transcript is read from where the last harvest stopped, so a turn costs the bytes it appended.
export class AttachmentHarvester {
  readonly #cursors = new Map<string, TranscriptCursor>();
  readonly #held = new Map<string, HeldAttachments>();

  harvest(source: AttachmentSource): Harvest {
    const transcript = nativeSessionPath(source);
    const size = NodeFS.statSync(transcript, { throwIfNoEntry: false })?.size ?? 0;
    let cursor = this.#cursors.get(transcript);
    if (cursor === undefined || size < cursor.offset) {
      cursor = { offset: 0, lines: new Map() };
      this.#cursors.set(transcript, cursor);
    }
    if (size === cursor.offset) return { found: 0, bytesRead: 0 };
    const chunk = readRange(transcript, cursor.offset, size);
    const whole = chunk.lastIndexOf(0x0a) + 1;
    const store = attachmentStorePath(source.home, source.threadId);
    const found: StoredAttachment[] = [];
    let held: HeldAttachments | undefined;
    for (const line of parseLines(chunk.subarray(0, whole).toString("utf8"))) {
      const uuid = line["uuid"];
      if (typeof uuid !== "string") continue;
      cursor.lines.set(uuid, { type: line["type"], parent: line["parentUuid"], source: line[PROJECTED_SOURCE_FIELD] });
      if (line["type"] !== "attachment" || PROJECTED_SOURCE_FIELD in line) continue;
      held ??= this.#heldIn(store);
      if (held.uuids.has(uuid)) continue;
      const anchor = anchorAbove(line["parentUuid"], cursor.lines);
      if (anchor === null) continue;
      found.push({
        uuid,
        anchor,
        line: Object.fromEntries(Object.entries(line).filter(([k]) => !RESTAMPED_FIELDS.has(k))),
      });
    }
    if (held !== undefined && found.length > 0) {
      NodeFS.mkdirSync(NodePath.dirname(store), { recursive: true });
      const body = found.map(({ uuid, anchor, line }) => `${JSON.stringify({ uuid, anchor, line })}\n`).join("");
      NodeFS.appendFileSync(store, held.torn ? `\n${body}` : body, { mode: 0o600 });
      held.torn = false;
      for (const { uuid } of found) held.uuids.add(uuid);
    }
    cursor.offset += whole;
    return { found: found.length, bytesRead: chunk.length };
  }

  #heldIn(store: string): HeldAttachments {
    let held = this.#held.get(store);
    if (held === undefined) {
      const body = readIfPresent(store);
      const uuids = new Set<string>();
      for (const record of parseLines(body)) if (typeof record["uuid"] === "string") uuids.add(record["uuid"]);
      held = { uuids, torn: body !== "" && !body.endsWith("\n") };
      this.#held.set(store, held);
    }
    return held;
  }
}

export async function readAttachments(
  home: string,
  threadId: string,
): Promise<ReadonlyMap<string, readonly StoredAttachment[]>> {
  const byAnchor = new Map<string, StoredAttachment[]>();
  const seen = new Set<string>();
  const body = await NodeFS.promises.readFile(attachmentStorePath(home, threadId), "utf8").catch(ifMissing(""));
  for (const record of parseLines(body)) {
    const { uuid, anchor, line } = record as Partial<StoredAttachment>;
    if (typeof uuid !== "string" || typeof anchor !== "string" || !isRecord(line) || seen.has(uuid)) continue;
    seen.add(uuid);
    const list = byAnchor.get(anchor) ?? [];
    list.push({ uuid, anchor, line });
    byAnchor.set(anchor, list);
  }
  return byAnchor;
}

function anchorAbove(start: unknown, lines: ReadonlyMap<string, ChainLine>): string | null {
  const seen = new Set<string>();
  let parent = start;
  while (typeof parent === "string" && !seen.has(parent)) {
    seen.add(parent);
    const above = lines.get(parent);
    if (above === undefined) return null;
    if (above.type === "user" || above.type === "assistant")
      return typeof above.source === "string" ? anchorOf(above.source) : messageKeyPrefix(parent);
    parent = above.parent;
  }
  return null;
}

function readRange(path: string, from: number, to: number): Buffer {
  const chunk = Buffer.alloc(to - from);
  const fd = NodeFS.openSync(path, "r");
  try {
    return chunk.subarray(0, NodeFS.readSync(fd, chunk, 0, chunk.length, from));
  } finally {
    NodeFS.closeSync(fd);
  }
}

function readIfPresent(path: string): string {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (cause) {
    return ifMissing("")(cause);
  }
}

function ifMissing<T>(fallback: T): (cause: unknown) => T {
  return (cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw cause;
  };
}

function parseLines(body: string): NativeEntry[] {
  const records: NativeEntry[] = [];
  for (const raw of body.split("\n")) {
    if (raw === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) records.push(parsed);
    } catch {}
  }
  return records;
}

function isRecord(value: unknown): value is NativeEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
