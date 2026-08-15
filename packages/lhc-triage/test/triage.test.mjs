import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { threads } from "../../lhc/dist/index.js";
import { openThread, readChunk, readIssues, readSummaries, readSummary, readTurn } from "../src/thread-reader.mjs";

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "lhc-triage-"));
  const filePath = join(dir, "thread.sqlite");
  const created = await threads.newThread({ filePath, registryPath: join(dir, "registry.sqlite") });
  assert.equal(created.ok, true);
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.prepare("UPDATE turns SET status='closed', closed_at_event_order=opened_at_event_order WHERE turn_id='t1'").run();
  db.prepare("INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens) VALUES ('c1',1,'closed',1200)").run();
  db.prepare("INSERT INTO chunk_member (chunk_id, turn_id, member_idx) VALUES ('c1','t1',0)").run();
  db.prepare(`INSERT INTO derivation
    (subject_kind,subject_id,derivation_type,state,content,reason,metadata,source_version,derived_at)
    VALUES ('chunk','c1','chunk_summary_detailed','ready','Detailed chunk summary',NULL,NULL,1,'2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO derivation
    (subject_kind,subject_id,derivation_type,state,content,reason,metadata,source_version,derived_at)
    VALUES ('turn','t1','detailed_turn_compression','failed',NULL,'claim_expired',NULL,1,'2026-01-01T00:00:00.000Z')`).run();
  const arrangement = JSON.stringify([
    { band: "brief", subjectKind: "chunk", subjectId: "c1", derivationUsed: "stored_member_concat", degraded: true },
    { band: "detailed", subjectKind: "turn", subjectId: "t1", derivationUsed: "gap", degraded: false },
  ]);
  const gaps = JSON.stringify([
    { band: "detailed", subjectId: "t1", reason: "no usable derivation" },
  ]);
  db.prepare(`INSERT INTO thread_view
    (singleton,view_id,created_at,compact_point,covered_from,profile_name,config_json,arrangement_json,gaps_json,source_state_json)
    VALUES (1,'v1','2026-01-01T00:00:00.000Z',1,1,NULL,?,?,?,?)`).run(
      JSON.stringify({ lowerBound: 1000, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } }),
      arrangement,
      gaps,
      JSON.stringify({ maxEventOrder: 1, derivationCounts: { detailed_turn_compression: { failed: 1 } } }),
    );
  db.prepare("INSERT INTO thread_view_band (view_id,band,rendered_text,token_count) VALUES ('v1','brief','fallback text',3)").run();
  db.close();
  return { dir, filePath };
}

test("summary and issue traversal read the real thread schema without writes", async () => {
  const { filePath } = await fixture();
  const before = await digest(filePath);
  const { db, filePath: absolute } = openThread(filePath);
  const summary = readSummary(db, absolute);
  const issues = readIssues(db);
  const turn = readTurn(db, "t1");
  const chunk = readChunk(db, "c1");
  const summaries = readSummaries(db, { type: "chunk-detailed", maxChars: 50 });
  db.close();
  const after = await digest(filePath);

  assert.equal(summary.integrity, "ok");
  assert.equal(summary.view?.degradedEntries, 1);
  assert.equal(summary.view?.gapEntries, 1);
  assert.equal(issues.failedOrBlocked.length, 1);
  assert.deepEqual(
    issues.missingExpected.map((item) => [item.subjectId, item.expectedDerivation]),
    [["c1", "chunk_summary_brief"]],
  );
  assert.equal(issues.degradedFallbacks.length, 1);
  assert.equal(issues.emptyGaps.length, 1);
  assert.equal(turn.derivations[0].state, "failed");
  assert.equal(chunk.members[0].turnId, "t1");
  assert.equal(summaries[0].preview, "Detailed chunk summary");
  assert.equal(after, before, "read-only traversal must not mutate the thread file");
});

test("CLI emits bounded machine-readable issue output", async () => {
  const { filePath } = await fixture();
  const cli = resolve("src/cli.mjs");
  const result = spawnSync(process.execPath, [cli, filePath, "issues", "--json"], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.failedOrBlocked[0].reason, "claim_expired");
  assert.equal(parsed.missingExpected[0].subjectId, "c1");
});
