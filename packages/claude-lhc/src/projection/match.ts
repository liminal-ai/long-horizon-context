import * as NodeFS from "node:fs";
import { messageKeyPrefix } from "../capture/mapper.js";
import { anchorOf, DANGLING_RESULT, type NativeEntry, PROJECTED_SOURCE_FIELD, SUMMARY_BAND } from "./project.js";

export type TranscriptMatch =
  | { readonly matches: true; readonly messages: number }
  | { readonly matches: false; readonly reason: string };

/**
 * A native transcript still holds the served view when the messages on its chain name the same captured
 * messages, in the same order, as a fresh projection of that view. The CLI writes each message under the uuid
 * claude-lhc captured it by, and a projected line names its capture key in `lhcSource`. A summary band has no
 * message of its own, so it must carry the same text.
 */
export async function matchTranscript(path: string, projected: readonly NativeEntry[]): Promise<TranscriptMatch> {
  const served = messageAnchors(projected);
  if (served.length === 0) return { matches: false, reason: "the served view is empty" };
  let body: string;
  try {
    body = await NodeFS.promises.readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return {
      matches: false,
      reason: code === "ENOENT" ? "it has no native transcript" : `its native transcript is unreadable (${code})`,
    };
  }
  const held = messageAnchors(leafChain(parseLines(body)));
  const at = served.findIndex((anchor, i) => held[i] !== anchor);
  if (at === -1 && held.length === served.length) return { matches: true, messages: served.length };
  return {
    matches: false,
    reason: `its native transcript differs from the served view at message ${(at === -1 ? served.length : at) + 1} (${held.length} held, ${served.length} served)`,
  };
}

function messageAnchors(lines: readonly NativeEntry[]): string[] {
  const anchors: string[] = [];
  for (const line of lines) {
    const anchor = messageAnchor(line);
    if (anchor !== null && anchor !== anchors.at(-1)) anchors.push(anchor);
  }
  return anchors;
}

function messageAnchor(line: NativeEntry): string | null {
  if ((line["type"] !== "user" && line["type"] !== "assistant") || line["isSidechain"] === true) return null;
  const content = (line["message"] as { content?: unknown } | undefined)?.content;
  if (line["type"] === "user" && typeof content === "string" && SUMMARY_BAND.test(content)) return `band:${content}`;
  const source = line[PROJECTED_SOURCE_FIELD];
  if (typeof source !== "string" && isDanglingResult(content)) return null;
  const key = typeof source === "string" ? source : messageKeyPrefix(String(line["uuid"]));
  return anchorOf(key) ?? key;
}

function isDanglingResult(content: unknown): boolean {
  if (!Array.isArray(content) || content.length !== 1) return false;
  const [block] = content as Array<Record<string, unknown>>;
  return block?.["type"] === "tool_result" && block["content"] === DANGLING_RESULT;
}

function leafChain(lines: readonly NativeEntry[]): NativeEntry[] {
  const byUuid = new Map<string, NativeEntry>();
  let leaf: NativeEntry | undefined;
  for (const line of lines) {
    if (typeof line["uuid"] !== "string") continue;
    byUuid.set(line["uuid"], line);
    if (messageAnchor(line) !== null) leaf = line;
  }
  const chain: NativeEntry[] = [];
  const seen = new Set<string>();
  for (let line = leaf; line !== undefined; ) {
    const uuid = String(line["uuid"]);
    if (seen.has(uuid)) break;
    seen.add(uuid);
    chain.push(line);
    const parent = line["parentUuid"];
    line = typeof parent === "string" ? byUuid.get(parent) : undefined;
  }
  return chain.reverse();
}

function parseLines(body: string): NativeEntry[] {
  const lines: NativeEntry[] = [];
  for (const raw of body.split("\n")) {
    if (raw === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) lines.push(parsed as NativeEntry);
    } catch {}
  }
  return lines;
}
