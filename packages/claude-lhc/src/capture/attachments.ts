import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { nativeSessionPath } from "../nativeSessionFile.js";
import {
  type AttachmentsByAnchor,
  anchorOf,
  type NativeEntry,
  PROJECTED_SOURCE_FIELD,
  type ProjectedAttachment,
} from "../projection/project.js";
import { messageKeyPrefix } from "./mapper.js";

// Projection writes these afresh for its own generation. The rest of an attachment line, `attachment` and the
// `rendered` text the CLI sends in place of re-rendering it, is kept as the CLI wrote it.
const ENVELOPE = new Set([
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

export async function harvestAttachments(source: AttachmentSource, log: (line: string) => void): Promise<number> {
  const startedAt = performance.now();
  try {
    const store = attachmentStorePath(source.home, source.threadId);
    const [native, stored] = await Promise.all([readJsonl(nativeSessionPath(source)), readJsonl(store)]);
    const held = new Set(stored.records.map((record) => record["uuid"]));
    const byUuid = new Map(native.records.map((line) => [line["uuid"], line]));
    const found: StoredAttachment[] = [];
    for (const line of native.records) {
      const uuid = line["uuid"];
      if (line["type"] !== "attachment" || typeof uuid !== "string" || held.has(uuid)) continue;
      if (PROJECTED_SOURCE_FIELD in line) continue;
      const anchor = anchorAbove(line, byUuid);
      if (anchor === null) continue;
      held.add(uuid);
      found.push({ uuid, anchor, line: Object.fromEntries(Object.entries(line).filter(([k]) => !ENVELOPE.has(k))) });
    }
    if (found.length > 0) {
      await NodeFS.promises.mkdir(NodePath.dirname(store), { recursive: true });
      const body = found.map(({ uuid, anchor, line }) => `${JSON.stringify({ uuid, anchor, line })}\n`).join("");
      await NodeFS.promises.appendFile(store, stored.torn ? `\n${body}` : body, { mode: 0o600 });
    }
    log(`attachments: ${found.length} new from ${source.sessionId} in ${Math.round(performance.now() - startedAt)} ms`);
    return found.length;
  } catch (cause) {
    log(
      `attachments: harvest from ${source.sessionId} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 0;
  }
}

export async function readAttachments(home: string, threadId: string): Promise<AttachmentsByAnchor> {
  const byAnchor = new Map<string, StoredAttachment[]>();
  const seen = new Set<string>();
  for (const record of (await readJsonl(attachmentStorePath(home, threadId))).records) {
    const { uuid, anchor, line } = record as Partial<StoredAttachment>;
    if (typeof uuid !== "string" || typeof anchor !== "string" || !isRecord(line) || seen.has(uuid)) continue;
    seen.add(uuid);
    const held = byAnchor.get(anchor) ?? [];
    held.push({ uuid, anchor, line });
    byAnchor.set(anchor, held);
  }
  return byAnchor;
}

// The CLI chains each attachment under the message it follows, and writes each message under the uuid its
// capture keys carry. A projected message carries its capture key in `lhcSource` instead.
function anchorAbove(line: NativeEntry, byUuid: ReadonlyMap<unknown, NativeEntry>): string | null {
  const seen = new Set<unknown>();
  let parent = line["parentUuid"];
  while (typeof parent === "string" && !seen.has(parent)) {
    seen.add(parent);
    const above = byUuid.get(parent);
    if (above === undefined) return null;
    if (above["type"] === "user" || above["type"] === "assistant") {
      const projected = above[PROJECTED_SOURCE_FIELD];
      return typeof projected === "string" ? anchorOf(projected) : messageKeyPrefix(parent);
    }
    parent = above["parentUuid"];
  }
  return null;
}

// A writer that died mid-line leaves a torn last line, which every reader skips.
async function readJsonl(path: string): Promise<{ records: NativeEntry[]; torn: boolean }> {
  const body = await NodeFS.promises.readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return "";
    throw cause;
  });
  const records: NativeEntry[] = [];
  for (const raw of body.split("\n")) {
    if (raw === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) records.push(parsed);
    } catch {}
  }
  return { records, torn: body !== "" && !body.endsWith("\n") };
}

function isRecord(value: unknown): value is NativeEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
