#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { event, fail, LHC_BIN, makeSdk, tempHome, unwrap } from "./lib.mjs";

const COMPACT_PARAMS = { lowerBound: 200, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } };
const DETAIL = " with enough supporting detail to give the turn real token weight".repeat(4);
const KEEP = "ROLLBACK-KEEP-1";
const DROPPED = ["ROLLBACK-DROP-2", "ROLLBACK-DROP-3"];
const NEW = "ROLLBACK-NEW-4";

function turn(marker) {
  return [
    event("user_prompt", { text: `${marker} please investigate this area` }),
    event("assistant_text", { text: `${marker} findings${DETAIL}` }),
    event("turn_end", {}),
  ];
}

function assertKeptOnly(label, text, expected) {
  for (const marker of DROPPED) if (text.includes(marker)) fail(`${label} still serves discarded ${marker}`);
  let from = -1;
  for (const marker of expected) {
    const at = text.indexOf(marker, from + 1);
    if (at <= from) fail(`${label} lost ${marker} or served it out of order`);
    from = at;
  }
}

const keep = process.argv.includes("--keep");
const store = tempHome("verify-lhc-rollback-");
try {
  const sdk = await makeSdk();
  const filePath = store.threadPath();
  const { threadId } = unwrap(
    await sdk.threads.newThread({ filePath, registryPath: store.registryPath, title: "verify-lhc rollback" }),
    "newThread",
  );
  const ref = { filePath };
  const kept = unwrap(await sdk.intakeStream.messageEvents(ref, turn(KEEP)), "turn 1");
  const keepThrough = kept.threadPosition.lastEventOrder;
  for (const marker of DROPPED) unwrap(await sdk.intakeStream.messageEvents(ref, turn(marker)), marker);
  unwrap(await sdk.work.drain(ref), "drain");
  const view = unwrap(await sdk.threadView.compact(ref, { params: COMPACT_PARAMS }), "compact before rollback");
  if (view.compactPoint <= keepThrough) fail(`compact point ${view.compactPoint} must sit past the anchor ${keepThrough}`);
  const before = JSON.stringify(unwrap(await sdk.threadView.getLlmRequestContext(ref), "serve before rollback"));
  for (const marker of DROPPED) if (!before.includes(marker)) fail(`setup: ${marker} not served before rollback`);
  console.log(`seeded 3 turns, compact point ${view.compactPoint}, rollback anchor ${keepThrough}`);

  const started = performance.now();
  const rolled = await sdk.intakeStream.messageEvents(ref, [
    event("rollback", { keepThroughEventOrder: keepThrough, reason: "verify-lhc rewind" }),
  ]);
  const settledMs = performance.now() - started;
  if (!rolled.ok) {
    console.log(`rollback refused: ${rolled.error.code} ${rolled.error.reason}`);
    console.log("verify-lhc rollback: UNSUPPORTED (this build has no rollback event)");
    store.cleanup();
    process.exit(3);
  }
  console.log(`rollback recorded in ${settledMs.toFixed(1)} ms`);

  assertKeptOnly("llm context after rollback", JSON.stringify(unwrap(await sdk.threadView.getLlmRequestContext(ref), "serve")), [KEEP]);
  assertKeptOnly("session view after rollback", JSON.stringify(unwrap(await sdk.threadView.getSessionThreadView(ref), "session")), [KEEP]);

  unwrap(await sdk.intakeStream.messageEvents(ref, turn(NEW)), "append after rollback");
  unwrap(await sdk.work.drain(ref), "drain after append");
  unwrap(await sdk.threadView.compact(ref, { params: COMPACT_PARAMS }), "compact after rollback");
  assertKeptOnly("llm context after recompact", JSON.stringify(unwrap(await sdk.threadView.getLlmRequestContext(ref), "serve")), [KEEP, NEW]);
  assertKeptOnly("session view after recompact", JSON.stringify(unwrap(await sdk.threadView.getSessionThreadView(ref), "session")), [KEEP, NEW]);
  console.log("served views after append and recompact: kept branch only, in order");

  const out = join(store.home, "export.json");
  execFileSync("node", [LHC_BIN, "thread", "export", "--home", store.home, "--thread-id", threadId, "--out", out], { encoding: "utf8" });
  const exported = readFileSync(out, "utf8");
  assertKeptOnly("cli export", exported, [KEEP, NEW]);
  const history = JSON.parse(exported);
  console.log(`cli export turns: ${history.turns.filter((t) => t.messages.length > 0).length} non-empty, kept branch only`);

  const all = unwrap(await sdk.messages.list(ref, { includeDeleted: true }), "list with deleted");
  const hidden = all.filter((m) => m.deleted === true).length;
  if (hidden !== 4) fail(`expected 4 hidden messages kept in the record, got ${hidden}`);
  console.log(`record keeps ${hidden} hidden messages under the deleted contract`);

  console.log("verify-lhc rollback: PASS");
  if (keep) console.log(`home kept at ${store.home} thread ${threadId}`);
} finally {
  if (!keep) store.cleanup();
}
