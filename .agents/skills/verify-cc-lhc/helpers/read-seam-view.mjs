#!/usr/bin/env node
// Writes the canonical LHC session view a Smart Compact rebuild was rendered from, for
// check-rebuilt-content.mjs --view. The writer reads the view at the seam and writes it straight to
// disk, so this rereads the view from the thread store afterwards and cuts it at the rebuild's
// receipt. Capture ingests the receipt line under its own uuid after the seam, so the entries before
// it are the seam view. A later compact or prune on the same thread replaces the bands; read the
// view before one runs.
// usage: read-seam-view.mjs --cc-lhc-home DIR --rebuilt NEW.jsonl --out VIEW.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../../../", import.meta.url);
const { messages, threads, threadView } = await import(new URL("packages/lhc/dist/index.js", root).href);
const { idempotencyKey } = await import(new URL("packages/cc-lhc/dist/intake/map.js", root).href);

const must = (result, what) => {
  if (!result.ok) throw new Error(`${what}: ${result.error.reason}`);
  return result.value;
};

// Each entry gains sourceKinds, the message kinds behind it, so the check can tell a typed
// compact_continuation_marker from a user prompt with the same text.
export async function annotatedSessionView(ref) {
  const view = must(await threadView.getSessionThreadView(ref), "getSessionThreadView");
  const kinds = new Map(
    must(await messages.list(ref, { includeDeleted: true }), "messages.list").map((m) => [m.messageId, m.kind]),
  );
  const entries = view.entries.map((entry) => ({
    ...entry,
    sourceKinds: (entry.sourceMessages ?? []).map((s) => kinds.get(s.messageId) ?? "unknown"),
  }));
  return { threadId: view.threadId, entries };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const home = opt("--cc-lhc-home");
  const rebuiltPath = opt("--rebuilt");
  const out = opt("--out");
  if (home === undefined || rebuiltPath === undefined || out === undefined) {
    console.error("usage: read-seam-view.mjs --cc-lhc-home DIR --rebuilt NEW.jsonl --out VIEW.json");
    process.exit(2);
  }
  const receipt = readFileSync(rebuiltPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .findLast((l) => l.type === "user" && typeof l.message?.content === "string" && l.message.content.startsWith("[runtime note] "));
  if (receipt === undefined) {
    console.log("FAIL the rebuilt transcript has no [runtime note] receipt, so the seam cannot be located");
    process.exit(1);
  }
  const key = idempotencyKey(receipt.uuid, 0, "runtime_note");
  for (const thread of must(await threads.listThreads({ registryPath: join(home, "registry.sqlite") }), "listThreads")) {
    const view = await annotatedSessionView({ filePath: thread.filePath });
    const at = view.entries.findIndex((e) => (e.sourceMessages ?? []).some((s) => s.idempotencyKey === key));
    if (at < 0) continue;
    writeFileSync(out, JSON.stringify({ ...view, receiptUuid: receipt.uuid, entries: view.entries.slice(0, at) }, null, 2));
    console.log(`OK thread=${view.threadId} seam_entries=${at} receipt=${receipt.uuid}`);
    process.exit(0);
  }
  console.log(`FAIL no thread under ${home} ingested the receipt ${receipt.uuid}, so the seam view cannot be located`);
  process.exit(1);
}
