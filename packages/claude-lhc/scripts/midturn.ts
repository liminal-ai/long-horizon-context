/**
 * Mid-turn compact proof, no t3code: a tool-heavy turn crosses the trigger before it ends,
 * the sidecar stops the query at a safe tool boundary (a parallel batch of three), rebuilds,
 * and the task finishes in a new session. PASSES (default 3) passes, each its own thread:
 *   sidecar A: "ready" (baseline B) → Read of a sample file (S per read) → Read of a big filler
 *              file (turn 3, closed; context C1) → stop
 *   sidecar B: resume with autoCompactWindow = C1 + 400 + 1.5·S, then the task:
 *              read value-1, value-2 one per response; value-3,4,5 in ONE response (parallel);
 *              value-6 alone; answer with six lines.
 *   The trigger is crossed by the assistant message that issues the parallel batch, so the
 *   seam must fall after all three of its results.
 * Checks per pass: six tool calls once each in order; every batch result on the wire before the
 * boundary; status→boundary order; exactly one result, from the new session; the six values
 * correct; LHC has the forced boundary turn, the marker, and the continuation as a runtime
 * note (not a prompt). Writes cp-midturn/pass-N.wire.log and cp-midturn/record.json.
 * PARTIAL=0 turns includePartialMessages off (t3code runs with it on, the default here).
 * FAIL_REBUILD=1 forces the rebuild to throw after the hook stop (start option lhc.forceRebuildFailure
 * on the task sidecar): the expectation flips to no boundary, status failed, the task finishing in the
 * stopped generation, still one result.
 *
 * Calibration: the account's MCP connectors join the tool list asynchronously (~24k tokens of
 * schemas), so a call made before they connect reads low. The baseline is a "ready" turn repeated
 * until the init reports no pending server; the task sidecar warms up the same way and its
 * settled context must sit between the calibrated C1 and trigger − S, else the pass fails as
 * miscalibrated rather than as a seam failure.
 * Exit 0 on pass. T3CODE_LHC_HOME defaults to <builder dir>/home/t3code-lhc.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initLhc, createDeterministicInferenceCallbacks, threads, type Lhc } from "lhc";
import { contextTokens, describe, fail, log, Sidecar, type Wire } from "./lib/sidecar.ts";

const HERE = import.meta.dir;
const BUILDER = resolve(HERE, "../../../..");
const LHC_HOME = process.env.T3CODE_LHC_HOME ?? join(BUILDER, "home/t3code-lhc");
const OUT = process.env.MIDTURN_OUT ?? join(BUILDER, "cp-midturn");
const PASSES = Number(process.env.PASSES ?? 3);
const FAIL_REBUILD = process.env.FAIL_REBUILD === "1";
const MODEL = process.env.MODEL ?? "claude-sonnet-5";
const VALUES = ["amber", "birch", "coral", "denim", "ember", "frost"];
const FILLER_CHARS = Number(process.env.FILLER_CHARS ?? 80_000);
const VALUE_CHARS = Number(process.env.VALUE_CHARS ?? 5_600);
mkdirSync(OUT, { recursive: true });

const WORDS = "harbor lantern meadow orchard quarry ridge saddle timber valley willow anchor beacon canyon delta estuary fjord glacier hollow island jetty".split(" ");
function filler(chars: number, seed: number): string {
  let out = ""; let i = seed;
  while (out.length < chars) { out += WORDS[i % WORDS.length] + ((i % 12) === 11 ? "\n" : " "); i += 7; }
  return out;
}
const baseOptions = (cwd: string, extra: Record<string, unknown>) => ({
  cwd, model: MODEL, pathToClaudeCodeExecutable: "claude",
  systemPrompt: "You are a careful agent in a deterministic tool-sequencing test. Follow the requested tool ordering literally: never batch, loop, glob, or read ahead beyond what the instructions say.",
  settingSources: [], tools: ["Read"],
  permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
  includePartialMessages: process.env.PARTIAL !== "0", env: process.env, additionalDirectories: [cwd], ...extra,
});
const bare = (m: Wire) => m["type"] !== "stream_event";

const registryPath = join(LHC_HOME, "registry.sqlite");
const lhc: Lhc = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
const record: Record<string, unknown>[] = [];

for (let pass = 1; pass <= PASSES; pass++) {
  log(`━━━ pass ${pass}/${PASSES}`);
  const cwd = mkdtempSync(join(tmpdir(), `claude-lhc-midturn-${pass}-`));
  writeFileSync(join(cwd, "sample.txt"), `SAMPLE=zero\n${filler(VALUE_CHARS, 3)}\n`);
  writeFileSync(join(cwd, "filler.txt"), `${filler(FILLER_CHARS, 1)}\nEND OF FILLER\n`);
  for (const [i, v] of VALUES.entries()) writeFileSync(join(cwd, `value-${i + 1}.txt`), `VALUE_${i + 1}=${v}\n${filler(VALUE_CHARS, 11 + i)}\n`);
  const first = randomUUID();
  const a = new Sidecar(`p${pass}-A`, LHC_HOME, true);
  a.send({ type: "start", options: baseOptions(cwd, { sessionId: first, settings: { autoCompactWindow: 300_000 } }) });
  const ready = await a.settledReady();
  const B = ready.context;
  const t2 = await a.turn(`Use the Read tool on ${join(cwd, "sample.txt")}, then reply with just the word after SAMPLE=.`);
  const S = t2.context - B;
  const t3 = await a.turn(`Use the Read tool on ${join(cwd, "filler.txt")} once, then reply with just: ok`);
  const C1 = t3.context;
  const trigger = Math.round(C1 + 400 + 1.5 * S);
  log(`baseline ${B} (settled after ${ready.tries} ready turn(s), ${ready.tools} tools), per-read ${S}, after filler ${C1} → trigger ${trigger}`);
  if (!t2.text.toLowerCase().includes("zero")) fail(`setup turn went wrong: ${JSON.stringify(t2.text)}`);
  if (S <= 0 || S > 20_000 || C1 <= B) fail(`calibration off: baseline ${B}, per-read ${S}, after filler ${C1}`);
  await a.stop();

  const b = new Sidecar(`p${pass}-B`, LHC_HOME, false);
  b.send({ type: "start", options: baseOptions(cwd, { resume: first, settings: { autoCompactWindow: trigger }, ...(FAIL_REBUILD ? { lhc: { forceRebuildFailure: true } } : {}) }) });
  const warm = await b.settledReady();
  log(`task sidecar warmed up: settled context ${warm.context} after ${warm.tries} ready turn(s), ${warm.tools} tools (calibrated C1 ${C1}, trigger ${trigger})`);
  if (warm.context < C1 - 2_000 || warm.context > trigger - S) fail(`pass ${pass}: miscalibrated, not a seam failure: task sidecar's settled context ${warm.context} is outside [${C1 - 2_000}, ${trigger - S}]`);
  const file = (i: number) => join(cwd, `value-${i}.txt`);
  const task = [
    "Deterministic sequencing test. Read six files with the Read tool, exactly as follows:",
    `Step 1: read ${file(1)} — one Read call, alone in its response.`,
    `Step 2: read ${file(2)} — one Read call, alone in its response.`,
    `Step 3: read ${file(3)}, ${file(4)} and ${file(5)} — all THREE Read calls in the SAME response, in parallel.`,
    `Step 4: read ${file(6)} — one Read call, alone in its response.`,
    "Step 5: answer with exactly six lines `1=<word>` … `6=<word>`, the word after VALUE_n= in each file. Nothing else.",
    "Never read a file twice. Never read ahead of the step you are on.",
  ].join("\n");
  const mark = b.messages.length;
  b.prompt(task);
  await b.waitFor(() => b.messages.slice(mark).some((m) => m["type"] === "result"), 400_000, "the task's result");
  const wireAll = b.messages.slice(mark);
  const wireTimes = b.arrivedAt.slice(mark);
  const wire = wireAll.filter(bare);
  const t0 = wireTimes[0] ?? Date.now();
  writeFileSync(join(OUT, `pass-${pass}.wire.log`), wireAll.map((m, i) => bare(m) ? `${String(wire.indexOf(m)).padStart(3)} +${String(wireTimes[i]! - t0).padStart(6)}ms ${describe(m)}` : null).filter((l) => l !== null).join("\n") + "\n");
  writeFileSync(join(OUT, `pass-${pass}.sidecar.log`), b.stderr.join("\n") + "\n");

  // ── checks
  const calls = wire.filter((m) => m["type"] === "assistant").flatMap((m, _i) => ((m["message"] as { content: Wire[] }).content).filter((c) => c["type"] === "tool_use").map((c) => ({ id: String(c["id"]), path: String((c["input"] as Wire)["file_path"]), at: wire.indexOf(m), sid: String(m["session_id"]), msg: String((m["message"] as { id?: string }).id ?? "") })));
  const order = calls.map((c) => Number(/value-(\d)\.txt$/.exec(c.path)?.[1] ?? 0));
  const results = wire.filter((m) => m["type"] === "result");
  const boundaryAt = wire.findIndex((m) => m["type"] === "system" && m["subtype"] === "compact_boundary");
  const statuses = wire.map((m, i) => m["type"] === "system" && m["subtype"] === "status" ? `${i}:${m["status"] ?? "null"}${m["compact_result"] ? ":" + m["compact_result"] : ""}` : null).filter((x): x is string => x !== null);
  const toolResultAt = new Map<string, number>();
  wire.forEach((m, i) => { if (m["type"] === "user") for (const c of ((m["message"] as { content: unknown }).content as Wire[] | string)) if (typeof c === "object" && c["type"] === "tool_result") toolResultAt.set(String(c["tool_use_id"]), i); });
  const finalText = results.at(-1) ? String(results.at(-1)!["result"]) : "";
  const correct = VALUES.every((v, i) => finalText.includes(`${i + 1}=${v}`));
  const inits = wire.filter((m) => m["type"] === "system" && m["subtype"] === "init").map((m) => String(m["session_id"]));
  const newSid = boundaryAt >= 0 ? String(wire[boundaryAt]!["session_id"]) : "";
  const batch = calls.filter((c) => [3, 4, 5].includes(Number(/value-(\d)\.txt$/.exec(c.path)?.[1])));
  const batchResolvedBefore = batch.every((c) => (toolResultAt.get(c.id) ?? Infinity) < boundaryAt);
  const summary = {
    pass, threadSession: first, baseline: B, perRead: S, afterFiller: C1, trigger,
    toolCalls: calls.map((c) => ({ file: c.path.split("/").at(-1), at: c.at, sid: c.sid.slice(0, 8), msg: c.msg.slice(-6), resultAt: toolResultAt.get(c.id) })),
    order, boundaryAt, boundary: boundaryAt >= 0 ? wire[boundaryAt]!["compact_metadata"] : null, statuses, results: results.map((r) => ({ subtype: r["subtype"], terminal: r["terminal_reason"], sid: String(r["session_id"]).slice(0, 8), is_error: r["is_error"] })),
    inits: inits.map((s) => s.slice(0, 8)), finalText, correct,
    contexts: wire.filter((m) => m["type"] === "assistant").map((m) => contextTokens(m)).filter((n) => n !== undefined),
    hookLog: b.stderr.filter((l) => /mid-turn|safe boundary|batch|wire after stop|swap complete/.test(l)),
    swapMs: Number(/swap complete: .* (\d+) ms after the hook stop/.exec(b.stderr.find((l) => l.includes("swap complete")) ?? "")?.[1] ?? -1),
  };
  log(JSON.stringify(summary, null, 1).replace(/\n\s*/g, " "));
  if (calls.length !== 6) fail(`pass ${pass}: ${calls.length} tool calls, expected 6`);
  if (JSON.stringify(order.slice(0, 2)) !== "[1,2]" || JSON.stringify([...order.slice(2, 5)].sort()) !== "[3,4,5]" || order[5] !== 6) fail(`pass ${pass}: tool order ${JSON.stringify(order)}`);
  if (new Set(batch.map((c) => c.msg)).size !== 1) fail(`pass ${pass}: value-3/4/5 were not one parallel batch (API message ids ${JSON.stringify(batch.map((c) => c.msg))})`);
  if (FAIL_REBUILD) {
    const oldSid = String(wire.find((m) => m["type"] === "assistant")?.["session_id"]);
    if (boundaryAt >= 0) fail(`pass ${pass}: a compact_boundary appeared although the rebuild was forced to fail`);
    // One mid-turn try, then the turn-end path's one try: two compacting/failed pairs, no more.
    if (statuses.filter((s) => s.endsWith(":compacting")).length !== 2 || statuses.filter((s) => s.endsWith(":null:failed")).length !== 2) fail(`pass ${pass}: status sequence ${JSON.stringify(statuses)}, expected exactly two compacting→failed pairs (mid-turn once, turn end once)`);
    if (results.length !== 1) fail(`pass ${pass}: ${results.length} results on the wire, expected 1`);
    if (results[0]!["session_id"] !== oldSid || results[0]!["is_error"] === true) fail(`pass ${pass}: result ${JSON.stringify(summary.results)} is not the stopped session's success`);
    if (calls.some((c) => c.sid !== oldSid)) fail(`pass ${pass}: a tool call ran outside the stopped session`);
    if (!correct) fail(`pass ${pass}: final answer wrong: ${JSON.stringify(finalText)}`);
    if (!b.stderr.some((l) => l.includes("continuing the turn in generation"))) fail(`pass ${pass}: sidecar log has no failure-path line`);
    log(`✓ pass ${pass} (forced rebuild failure): 6 reads once each, status compacting→failed, no boundary, the stopped generation ${oldSid.slice(0, 8)} took the continuation note and finished with one result, answer correct`);
  } else {
  if (boundaryAt < 0) fail(`pass ${pass}: no compact_boundary in the turn`);
  if (!batchResolvedBefore) fail(`pass ${pass}: a batch result landed after the boundary (${JSON.stringify(summary.toolCalls)})`);
  if (calls.slice(0, 5).some((c) => c.at > boundaryAt) || calls[5]!.at < boundaryAt) fail(`pass ${pass}: the seam is not between the batch and value-6`);
  if (results.length !== 1) fail(`pass ${pass}: ${results.length} results on the wire, expected 1`);
  if (results[0]!["session_id"] !== newSid || results[0]!["is_error"] === true) fail(`pass ${pass}: result ${JSON.stringify(summary.results)} is not the new session's success`);
  if (!statuses.some((s) => s.endsWith(":compacting")) || !statuses.some((s) => s.endsWith(":null:success"))) fail(`pass ${pass}: status sequence ${JSON.stringify(statuses)}`);
  if (!correct) fail(`pass ${pass}: final answer wrong: ${JSON.stringify(finalText)}`);
  if (calls[5]!.sid !== newSid) fail(`pass ${pass}: value-6 was read on ${calls[5]!.sid}, not the new session`);
  log(`✓ pass ${pass}: 6 reads once each, batch of 3 resolved before the boundary at ${boundaryAt}, one result on ${newSid.slice(0, 8)}, answer correct`);
  }

  // ── LHC side
  const r = await threads.resolveAlias({ alias: `t3code-lhc:${first}`, registryPath });
  if (!r.ok) fail("alias resolution failed");
  const ref = { threadId: r.value.threadId, registryPath };
  const turns = await lhc.turns.listTurns(ref);
  const events = await lhc.intakeStream.listEvents(ref);
  if (!turns.ok || !events.ok) fail("LHC read failed");
  const kinds = events.value.reduce<Record<string, number>>((acc, e) => { acc[e.eventKind] = (acc[e.eventKind] ?? 0) + 1; return acc; }, {});
  const turnList = turns.value.map((t) => ({ id: t.turnId, status: t.status, members: t.memberMessageIds.length, outcome: t.outcome ?? null, reason: t.outcomeReason ?? null }));
  log(`LHC thread ${ref.threadId}: events ${JSON.stringify(kinds)}`);
  for (const t of turnList) log(`  turn ${t.id} ${t.status} members=${t.members} outcome=${t.outcome} reason=${t.reason}`);
  const forced = turnList.filter((t) => t.reason === "context_compact_continue");
  if (forced.length !== 1) fail(`pass ${pass}: expected one forced boundary turn, got ${JSON.stringify(forced)}`);
  const notes = events.value.filter((e) => e.eventKind === "runtime_note" && String((e.payload as { text?: string }).text ?? "").includes("compacted in the middle of this turn"));
  if (notes.length !== 1) fail(`pass ${pass}: continuation note recorded ${notes.length} times as runtime_note`);
  const promptsWithNote = events.value.filter((e) => e.eventKind === "user_prompt" && String((e.payload as { text?: string }).text ?? "").includes("compacted in the middle"));
  if (promptsWithNote.length !== 0) fail(`pass ${pass}: the continuation was recorded as a user prompt`);
  if (FAIL_REBUILD) {
    if (kinds["compact_continuation_marker"]) fail(`pass ${pass}: a continuation marker was recorded although the rebuild failed`);
    log(`✓ pass ${pass}: LHC closed the turn on context_compact_continue, no marker, the continuation as a runtime note; the rest of the task is the next turn`);
  } else {
    if (!kinds["compact_continuation_marker"]) fail(`pass ${pass}: no continuation marker`);
    log(`✓ pass ${pass}: LHC closed the turn on context_compact_continue, recorded the marker and the continuation as a runtime note`);
  }
  await b.stop();
  record.push({ ...summary, threadId: ref.threadId, turns: turnList, eventKinds: kinds, cwd });
  writeFileSync(join(OUT, "record.json"), JSON.stringify(record, null, 2) + "\n");
}
console.log("RESULT: PASS");
process.exit(0);
