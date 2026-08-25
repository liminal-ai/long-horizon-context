#!/usr/bin/env node
/**
 * Turn-parts TS→Rust differential oracle (Story 4 acceptance spine).
 *
 * Runs scripted turn-parts scenarios through the TypeScript SDK (the frozen
 * contract) and records, per compact, the bytes the Rust port must reproduce
 * exactly: the receipt's placement/config projection, every rendered band,
 * the stored config/arrangement/gaps JSON as persisted, the served LLM
 * request context, and the host metadata. Rust replays the same intake
 * script (tests/turn_parts_oracle.rs) and compares byte-for-byte.
 *
 * Scenarios never drain the work queue: every construction is composed from
 * canonical in-walk, so no inference double is involved on either side.
 *
 * Regenerate (from packages/lhc-rs, with packages/lhc built):
 *   node scripts/gen-turn-parts-oracle.mjs
 * Writes fixtures/turn-parts-oracle.json.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createDeterministicInferenceCallbacks, initLhc } from "../../lhc/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "fixtures", "turn-parts-oracle.json");
const CREATED_AT = "2026-08-24T00:00:00.000Z";

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}
const canon = (value) => JSON.stringify(sortKeys(value));

let seq = 0;
const ev = (eventKind, payload) => ({ eventKind, idempotencyKey: `oracle-${++seq}`, actor: "oracle", harness: "oracle", payload });
const prompt = (text) => ev("user_prompt", { text });
const turnEnd = () => ev("turn_end", {});
function step(stepIndex, label, weight = 6) {
  const body = `${label} `.repeat(weight).trim();
  return [
    ev("assistant_text", { text: `step ${stepIndex}: ${body}`, stepIndex }),
    ev("tool_call", { toolCallId: `c${stepIndex}-${label}`, toolName: "read", arguments: { step: stepIndex }, stepIndex }),
    ev("tool_result", { toolCallId: `c${stepIndex}-${label}`, content: `result ${stepIndex}: ${body}`, stepIndex }),
  ];
}
const closedTurn = (label, weight = 1) => [
  prompt(`${label} prompt`),
  ev("assistant_text", { text: `${label} answer `.repeat(weight).trim() }),
  turnEnd(),
];
const GIANT = Array.from({ length: 300 }, (_, i) => `line ${i} of a very long assistant message body`).join("\n");

function stepSums(filePath, turnId) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT step_index AS s, MAX(source_event_order) AS edge FROM message
         WHERE turn_id = ? AND step_index IS NOT NULL GROUP BY step_index ORDER BY step_index`,
      )
      .all(turnId);
    const after = new Map();
    for (const row of rows) {
      const sum = db
        .prepare(`SELECT COALESCE(SUM(token_estimate), 0) AS t FROM message WHERE source_event_order > ? AND deleted_at IS NULL`)
        .get(Number(row.edge));
      after.set(Number(row.s), Number(sum.t));
    }
    return after;
  } finally {
    db.close();
  }
}
function turnTokens(filePath, turnId) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return Number(db.prepare(`SELECT COALESCE(SUM(token_estimate), 0) AS t FROM message WHERE turn_id = ?`).get(turnId).t);
  } finally {
    db.close();
  }
}
function storedRows(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT config_json, arrangement_json, gaps_json FROM thread_view WHERE singleton = 1`).get();
    const meta = db.prepare(`SELECT parts_activated_at FROM thread_metadata WHERE id = 1`).get();
    return { configJson: row.config_json, arrangementJson: row.arrangement_json, gapsJson: row.gaps_json, partsActivatedAt: meta.parts_activated_at };
  } finally {
    db.close();
  }
}

const splitParams = (lowerBound) => ({ lowerBound, percentages: { full: 50, smooth: 20, detailed: 15, brief: 15 }, newestClosedProtection: 0 });

const tmp = mkdtempSync(join(tmpdir(), "lhc-turn-parts-oracle-"));
const sdk = initLhc({ inferenceCallbacks: createDeterministicInferenceCallbacks(), mode: "manual" });
const scenarios = [];

async function scenario(name, script) {
  const filePath = join(tmp, `${name}.sqlite`);
  const created = await sdk.threads.newThread({ filePath, registryPath: join(tmp, "registry.sqlite") });
  if (!created.ok) throw new Error(created.error.reason);
  const ops = [];
  const send = async (events) => {
    const sent = await sdk.intakeStream.messageEvents({ filePath }, events);
    if (!sent.ok) throw new Error(sent.error.reason);
    ops.push({ op: "send", events });
  };
  const compact = async (params) => {
    const prepared = await sdk.threadView.prepareCompact({ filePath }, { params });
    if (!prepared.ok) throw new Error(prepared.error.reason);
    const receipt = await sdk.threadView.installPreparedCompact({ filePath }, prepared.value, { createdAt: CREATED_AT });
    if (!receipt.ok) throw new Error(receipt.error.reason);
    const r = receipt.value;
    const context = await sdk.threadView.getLlmRequestContext({ filePath });
    if (!context.ok) throw new Error(context.error.reason);
    const metadata = await sdk.threadView.hostMetadata({ filePath });
    if (!metadata.ok) throw new Error(metadata.error.reason);
    const entries = prepared.value.selection.entries.map((e) => ({
      band: e.band,
      subjectKind: e.subjectKind,
      subjectId: e.subjectId,
      derivationUsed: e.derivationUsed,
      degraded: e.degraded,
      gap: e.gap,
      startOrder: e.startOrder,
      tokens: e.tokens,
      text: e.text,
      ...(e.part !== undefined ? { part: e.part } : {}),
    }));
    ops.push({
      op: "compact",
      params,
      createdAt: CREATED_AT,
      expect: {
        receipt: canon({
          viewId: r.viewId,
          compactPoint: r.compactPoint,
          coveredFrom: r.coveredFrom,
          tailTokens: r.tailTokens,
          totalTokens: r.totalTokens,
          bands: r.bands,
          config: r.config,
          parts: r.parts ?? null,
          splitPoint: r.splitPoint ?? null,
          settled: r.settled ?? null,
          protectedTurn: r.protectedTurn ?? null,
          firstKeptMessageId: r.firstKeptMessageId,
        }),
        renderedBands: r.renderedBands,
        entries: canon(entries),
        stored: storedRows(filePath),
        served: canon(context.value.messages),
        hostMetadata: canon(metadata.value),
      },
    });
    return r;
  };
  await script({ filePath, send, compact });
  scenarios.push({ name, ops });
}

// S1 — split at the inclusive tie on step 1's edge; in-flight step 4.
await scenario("split_tie_inflight", async ({ filePath, send, compact }) => {
  await send(closedTurn("t1"));
  await send([
    prompt("long task"),
    ...step(0, "alpha"),
    ...step(1, "bravo"),
    ...step(2, "charlie"),
    ...step(3, "delta"),
    ev("assistant_text", { text: "step 4: working", stepIndex: 4 }),
    ev("tool_call", { toolCallId: "c4", toolName: "read", arguments: {}, stepIndex: 4 }),
  ]);
  await compact(splitParams(stepSums(filePath, "t2").get(1) * 2));
});

// S2 — monotone growth: relaxed budget keeps k; later pressure appends a part.
await scenario("grow_monotone", async ({ filePath, send, compact }) => {
  await send(closedTurn("t1"));
  await send([prompt("long task"), ...step(0, "alpha"), ...step(1, "bravo"), ...step(2, "charlie")]);
  await compact(splitParams(stepSums(filePath, "t2").get(0) * 2));
  await compact(splitParams(100_000));
  await send([...step(3, "delta"), ...step(4, "echo"), ...step(5, "foxtrot")]);
  await compact(splitParams(stepSums(filePath, "t2").get(3) * 2));
});

// S3 — close, lazy keep, settle-before-split (composed in-walk), t3 splits.
await scenario("close_lazy_settle_split", async ({ filePath, send, compact }) => {
  await send(closedTurn("t1"));
  await send([prompt("long task"), ...step(0, "alpha"), ...step(1, "bravo"), ...step(2, "charlie")]);
  await compact(splitParams(stepSums(filePath, "t2").get(0) * 2));
  await send([turnEnd()]);
  await send([prompt("next")]);
  await compact(splitParams(100_000));
  await send([...step(0, "golf"), ...step(1, "hotel"), ...step(2, "india"), ...step(3, "juliet")]);
  await compact(splitParams(stepSums(filePath, "t3").get(1) * 2));
});

// S4 — F1 cap: giant prompt and giant step text in the part; tag-shaped trap body.
await scenario("cap_giant_and_trap", async ({ send, compact }) => {
  const lines = GIANT.split("\n");
  const trap = [...lines.slice(0, 20), "</m6>", "<m6>", ...lines.slice(20)].join("\n");
  await send([prompt("t1 prompt"), ev("assistant_text", { text: "t1 answer" }), turnEnd()]);
  await send([
    prompt(`please read this\n${GIANT}`),
    ev("assistant_text", { text: GIANT, stepIndex: 0 }),
    ev("assistant_text", { text: trap, stepIndex: 0 }),
    ev("assistant_text", { text: "step 1 short", stepIndex: 1 }),
  ]);
  await compact({ lowerBound: 400, percentages: { full: 50, smooth: 50, detailed: 0, brief: 0 } });
});

// S5 — Flow 5: newest closed turn kept full; then over the bound → whole rendering composed in-walk.
await scenario("protection_full_then_whole", async ({ filePath, send, compact }) => {
  for (let i = 1; i <= 6; i += 1) await send(closedTurn(`old${i}`, 3));
  await send(closedTurn("research", 40));
  const research = turnTokens(filePath, "t7");
  await compact({ lowerBound: Math.ceil(research / 0.6) + 10, percentages: { full: 20, smooth: 30, detailed: 25, brief: 25 } });
  await compact({ lowerBound: research * 6, percentages: { full: 8, smooth: 42, detailed: 25, brief: 25 }, newestClosedProtection: 0.1 });
});

// S6 — precedence: under a planned split the whole active turn is reserved first.
await scenario("protection_precedence_reserve", async ({ filePath, send, compact }) => {
  for (let i = 1; i <= 6; i += 1) await send(closedTurn(`old${i}`, 3));
  await send(closedTurn("research", 40));
  await send([
    prompt("task"),
    ev("assistant_text", { text: "step 0 ".repeat(30), stepIndex: 0 }),
    ev("assistant_text", { text: "step 1 ".repeat(60), stepIndex: 1 }),
  ]);
  const research = turnTokens(filePath, "t7");
  const db = new DatabaseSync(filePath, { readOnly: true });
  const step1 = Number(db.prepare(`SELECT token_estimate AS t FROM message WHERE turn_id = 't8' AND step_index = 1`).get().t);
  db.close();
  await compact({ lowerBound: step1 + Math.floor(research / 2), percentages: { full: 10, smooth: 30, detailed: 30, brief: 30 } });
});

writeFileSync(out, `${JSON.stringify({ generatedBy: "scripts/gen-turn-parts-oracle.mjs", createdAt: CREATED_AT, scenarios }, null, 2)}\n`);
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out}: ${scenarios.length} scenarios, ${scenarios.reduce((n, s) => n + s.ops.filter((o) => o.op === "compact").length, 0)} compacts`);
