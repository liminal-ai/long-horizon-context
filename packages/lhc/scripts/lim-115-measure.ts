// LIM-115 measurement harness: what each Smart Compact plan costs on a mature
// thread.
//
// The parent generates one record, then measures each plan in its OWN fresh
// child process against its OWN frozen copy of that record. That isolation is
// the point: run sequentially in one process, peak RSS and RSS deltas are
// biased by whatever the first plan retained, by GC timing, and by the modules
// the first plan already loaded — the numbers stop being comparable. Four
// children run in total: {bounded, legacy} × {selection only, whole prepare},
// each measuring one thing once.
//
// This is harness process isolation, not a third algorithm mode: each child
// selects one of the same two product states the same way production does,
// through LHC_COMPACT_ALGORITHM.
//
// Not a test: it writes a multi-hundred-megabyte file and takes minutes. Run it
// deliberately.
//
//   node_modules/.bin/tsx scripts/lim-115-measure.ts [outDir]
//   LIM115_BARE_CHUNKS=0.4 node_modules/.bin/tsx scripts/lim-115-measure.ts
//
// Peak RSS is sampled, not instrumented: a short-lived transient between
// samples is missed, and RSS includes the process's own module load. Both
// numbers are reported — absolute peak and peak over this child's own
// post-warm-up baseline — and neither is normalized.
//
// The record is generated, never copied from a live thread, and no message
// content here is anything but filler.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { threads, threadView } from "../src/index.ts";
import { estimateTokens } from "../src/shared-tech/token-counting/index.ts";
import { createBoundedSelection } from "../src/thread-view/internal/bounded-source.ts";
import { eagerSelectionSource, readSelectionInputs } from "../src/thread-view/internal/select.ts";
import { walkArrangement } from "../src/thread-view/internal/walk.ts";
import { getChunkText } from "../src/turns/index.ts";

const TURNS = 3880;
const MESSAGES_PER_TURN = 10;
const TURNS_PER_CHUNK = 8;
/**
 * Fraction of the oldest chunks left with no stored summaries. 0 is the
 * healthy record — the shape LIM-115 is about, where the bounded plan reads
 * metadata and nothing else. Raise it (LIM115_BARE_CHUNKS=0.4) to see what a
 * record whose chunk summaries never landed costs either plan: that hydration
 * is the band ladder's fallback doing its job, not the plan being eager.
 */
const CHUNKS_WITHOUT_SUMMARIES = Number(process.env["LIM115_BARE_CHUNKS"] ?? "0");
const TOOL_RESULT_BYTES = 6000;

const PARAMS = { lowerBound: 60_000, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } };

type Plan = "bounded" | "legacy";
type Phase = "select" | "prepare";

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function generate(filePath: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = OFF;");
    db.exec("BEGIN;");
    const insertEvent = db.prepare(
      `INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
       VALUES (?, ?, ?, 'measure', 'measure', ?, ?)`,
    );
    const insertMessage = db.prepare(
      `INSERT INTO message (message_id, source_event_order, kind, token_estimate, actor, harness, turn_id)
       VALUES (?, ?, ?, ?, 'measure', 'measure', ?)`,
    );
    const insertBlock = db.prepare(
      `INSERT INTO message_block (message_id, block_index, block_type, content) VALUES (?, 0, ?, ?)`,
    );
    const insertTurn = db.prepare(
      `INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order, closed_at_event_order)
       VALUES (?, ?, 'closed', ?, ?)`,
    );
    const insertChunk = db.prepare(
      `INSERT INTO chunk (chunk_id, chunk_order, status, accumulated_projected_tokens) VALUES (?, ?, 'closed', 0)`,
    );
    const insertMember = db.prepare(`INSERT INTO chunk_member (chunk_id, turn_id, member_idx) VALUES (?, ?, ?)`);
    const insertDerivation = db.prepare(
      `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content, source_version, derived_at)
       VALUES (?, ?, ?, 'ready', ?, 1, '2026-01-01T00:00:00.000Z')`,
    );

    // The thread-creation row is turn t1, open; the generated record replaces it.
    db.prepare(`DELETE FROM turns WHERE turn_id = 't1'`).run();

    const toolBody = "tool output filler ".repeat(Math.ceil(TOOL_RESULT_BYTES / 19));
    // Word-shaped filler: long runs of one character are pathological for the
    // BPE estimator and would make the walk's cost unrepresentative.
    const words = (count: number, seed: string): string =>
      Array.from({ length: count }, (_, index) => `${seed}${index % 97} detail line`).join(" ");
    let order = 0;
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const turnId = `t${turn}`;
      const openedAt = order + 1;
      // The turn row lands before its messages: message.turn_id is a real
      // foreign key.
      insertTurn.run(turnId, turn, openedAt, openedAt + MESSAGES_PER_TURN - 1);
      for (let index = 0; index < MESSAGES_PER_TURN; index += 1) {
        order += 1;
        const kind =
          index === 0
            ? "user_prompt"
            : index === MESSAGES_PER_TURN - 1
              ? "assistant_text"
              : index % 2 === 1
                ? "tool_call"
                : "tool_result";
        const content =
          kind === "tool_call"
            ? JSON.stringify({ toolCallId: `c${order}`, toolName: "read_file", arguments: { path: `f${order}.txt` } })
            : kind === "tool_result"
              ? JSON.stringify({ toolCallId: `c${order - 1}`, content: toolBody, isError: false })
              : JSON.stringify({ text: `turn ${turn} ${kind} filler ${"z".repeat(200)}` });
        insertEvent.run(order, kind, `measure-${order}`, content, "2026-01-01T00:00:00.000Z");
        insertMessage.run(`m${order}`, order, kind, Math.ceil(content.length / 4), turnId);
        insertBlock.run(`m${order}`, kind, content);
      }
      insertDerivation.run("turn", turnId, "turn_rendering", `rendering for ${turnId} ${words(30, "area")}`);
      insertDerivation.run(
        "turn",
        turnId,
        "detailed_turn_compression",
        `compression for ${turnId} ${words(45, "topic")}`,
      );
    }

    const chunkCount = Math.floor(TURNS / TURNS_PER_CHUNK);
    const bareChunks = Math.floor(chunkCount * CHUNKS_WITHOUT_SUMMARIES);
    for (let chunk = 1; chunk <= chunkCount; chunk += 1) {
      const chunkId = `k${chunk}`;
      insertChunk.run(chunkId, chunk);
      for (let member = 0; member < TURNS_PER_CHUNK; member += 1) {
        insertMember.run(chunkId, `t${(chunk - 1) * TURNS_PER_CHUNK + member + 1}`, member);
      }
      // The oldest chunks carry no summaries: material the eager plan resolves
      // from stored members for every one of them, visited or not.
      if (chunk > bareChunks) {
        insertDerivation.run("chunk", chunkId, "chunk_summary_detailed", `detailed ${chunkId} ${words(60, "span")}`);
        insertDerivation.run("chunk", chunkId, "chunk_summary_brief", `brief ${chunkId} ${words(15, "gist")}`);
      }
    }
    db.exec("COMMIT;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}

// ── the child: one plan, one phase, one process ──────────────────

interface ChildResult {
  plan: Plan;
  phase: Phase;
  baselineRssMb: number;
  peakRssMb: number;
  peakOverBaselineMb: number;
  readMs?: number;
  walkMs?: number;
  prepareMs?: number;
  compactPoint: number;
  entries: number;
  /** Digest of the whole arrangement, so the parent can compare plans exactly. */
  arrangementSha: string;
  stats?: unknown;
}

function selectionDigest(selection: unknown): string {
  return createHash("sha256").update(JSON.stringify(selection)).digest("hex");
}

async function runChild(plan: Plan, phase: Phase, filePath: string): Promise<ChildResult> {
  if (plan === "legacy") process.env["LHC_COMPACT_ALGORITHM"] = "legacy";
  else delete process.env["LHC_COMPACT_ALGORITHM"];

  // Warm the token estimator before the baseline so its tables are charged to
  // neither plan's measurement.
  estimateTokens("warm the token estimator");
  const baselineRssMb = rssMb();
  let peak = baselineRssMb;
  const sampler = setInterval(() => {
    peak = Math.max(peak, rssMb());
  }, 10);

  let result: Omit<ChildResult, "plan" | "phase" | "baselineRssMb" | "peakRssMb" | "peakOverBaselineMb">;
  try {
    if (phase === "prepare") {
      const started = performance.now();
      const prepared = await threadView.prepareCompact({ filePath }, { params: PARAMS });
      const prepareMs = Math.round(performance.now() - started);
      if (!prepared.ok) throw new Error(`prepareCompact failed: ${prepared.error.reason}`);
      result = {
        prepareMs,
        compactPoint: prepared.value.selection.compactPoint,
        entries: prepared.value.selection.entries.length,
        arrangementSha: selectionDigest(prepared.value.selection),
      };
    } else {
      const db = new DatabaseSync(filePath);
      try {
        const transaction = { db, filePath, threadId: "measure" };
        const readStarted = performance.now();
        let source: ReturnType<typeof eagerSelectionSource>;
        let stats: unknown;
        if (plan === "bounded") {
          const bounded = createBoundedSelection(db, transaction, {
            includeChunkMaterials: true,
            signal: undefined,
          });
          source = bounded.source;
          stats = bounded.stats;
        } else {
          const inputs = readSelectionInputs(db);
          const materials = new Map<string, ReturnType<typeof getChunkText>>();
          for (const chunk of inputs.chunks) {
            if (chunk.status !== "closed") continue;
            for (const derivationType of ["chunk_summary_detailed", "chunk_summary_brief"] as const) {
              const material = getChunkText(transaction, chunk.chunkId, derivationType);
              if (material.kind === "blocked") continue;
              materials.set(`${chunk.chunkId}/${derivationType}`, material);
            }
          }
          source = eagerSelectionSource({ ...inputs, compactChunkMaterials: materials as never });
        }
        const readMs = Math.round(performance.now() - readStarted);
        const walkStarted = performance.now();
        const selection = walkArrangement(source, PARAMS);
        const walkMs = Math.round(performance.now() - walkStarted);
        result = {
          readMs,
          walkMs,
          compactPoint: selection.compactPoint,
          entries: selection.entries.length,
          arrangementSha: selectionDigest(selection),
          ...(stats === undefined ? {} : { stats }),
        };
      } finally {
        db.close();
      }
    }
  } finally {
    clearInterval(sampler);
  }
  peak = Math.max(peak, rssMb());
  return { plan, phase, baselineRssMb, peakRssMb: peak, peakOverBaselineMb: peak - baselineRssMb, ...result };
}

if (process.argv[2] === "--child") {
  const plan = process.argv[3] as Plan;
  const phase = process.argv[4] as Phase;
  const filePath = process.argv[5] as string;
  process.stdout.write(`${JSON.stringify(await runChild(plan, phase, filePath))}\n`);
  process.exit(0);
}

// ── the parent: generate once, measure in fresh children ─────────

const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "lim-115-measure-"));
mkdirSync(outDir, { recursive: true });

const sourcePath = join(outDir, "mature.sqlite");
const registryPath = join(outDir, "registry.sqlite");
log(`generating ${TURNS * MESSAGES_PER_TURN} messages into ${sourcePath}`);
const created = await threads.newThread({ filePath: sourcePath, registryPath });
if (!created.ok) throw new Error(created.error.reason);
const generateStarted = performance.now();
generate(sourcePath);
log(`generated in ${Math.round((performance.now() - generateStarted) / 1000)}s`);

const inventoryDb = new DatabaseSync(sourcePath);
const count = (sql: string): number => Number((inventoryDb.prepare(sql).get() as { n: number | bigint }).n);
const inventory = {
  fileMb: Math.round(statSync(sourcePath).size / 1024 / 1024),
  liveMessages: count(`SELECT COUNT(*) AS n FROM message WHERE deleted_at IS NULL`),
  messageBlocks: count(`SELECT COUNT(*) AS n FROM message_block`),
  turns: count(`SELECT COUNT(*) AS n FROM turns`),
  closedChunks: count(`SELECT COUNT(*) AS n FROM chunk WHERE status = 'closed'`),
  chunksWithoutSummaries: count(
    `SELECT COUNT(*) AS n FROM chunk c WHERE NOT EXISTS (
       SELECT 1 FROM derivation d WHERE d.subject_kind = 'chunk' AND d.subject_id = c.chunk_id)`,
  ),
  derivations: count(`SELECT COUNT(*) AS n FROM derivation`),
};
inventoryDb.close();
log(`record: ${JSON.stringify(inventory)}`);

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const self = fileURLToPath(import.meta.url);

function measure(plan: Plan, phase: Phase): ChildResult {
  // Its own frozen copy: no child can see another's writes, and no child
  // inherits another's heap.
  const copy = join(outDir, `mature-${plan}-${phase}.sqlite`);
  copyFileSync(sourcePath, copy);
  try {
    const run = spawnSync(tsx, [self, "--child", plan, phase, copy], { encoding: "utf8", maxBuffer: 1 << 24 });
    if (run.status !== 0) throw new Error(`child ${plan}/${phase} failed: ${run.stderr}`);
    const line = run.stdout.trim().split("\n").at(-1) as string;
    return JSON.parse(line) as ChildResult;
  } finally {
    rmSync(copy, { force: true });
    rmSync(`${copy}-wal`, { force: true });
    rmSync(`${copy}-shm`, { force: true });
  }
}

const results: ChildResult[] = [];
for (const phase of ["select", "prepare"] as const) {
  for (const plan of ["bounded", "legacy"] as const) {
    results.push(measure(plan, phase));
  }
}

const selects = results.filter((row) => row.phase === "select");
const prepares = results.filter((row) => row.phase === "prepare");
const digests = new Set(results.map((row) => row.arrangementSha));
if (digests.size !== 1) {
  throw new Error(
    `measurement invariant: the plans disagreed on the generated record — ${JSON.stringify(
      results.map((row) => ({ plan: row.plan, phase: row.phase, sha: row.arrangementSha.slice(0, 12) })),
    )}`,
  );
}

const boundedStats = selects.find((row) => row.plan === "bounded")?.stats;
log(`bounded loads: ${JSON.stringify(boundedStats)}`);
log(
  `eager loads (by construction): messageRows=${inventory.liveMessages} blockRows=${inventory.messageBlocks} ` +
    `chunkMaterialResolutions=${inventory.closedChunks * 2} derivationContentRows=${inventory.derivations}`,
);
for (const row of selects) {
  log(
    `selection [${row.plan}]: read=${row.readMs}ms walk=${row.walkMs}ms ` +
      `peakRss=${row.peakRssMb}MB (baseline ${row.baselineRssMb}MB, +${row.peakOverBaselineMb}MB)`,
  );
}
for (const row of prepares) {
  log(
    `prepareCompact [${row.plan}]: ${row.prepareMs}ms ` +
      `peakRss=${row.peakRssMb}MB (baseline ${row.baselineRssMb}MB, +${row.peakOverBaselineMb}MB)`,
  );
}
log(
  `arrangement (identical across all four children): compactPoint=${results[0]?.compactPoint} ` +
    `entries=${results[0]?.entries} sha256=${results[0]?.arrangementSha}`,
);
