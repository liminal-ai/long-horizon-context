import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, intakeStream, threads } from "../src/index.js";
import { getSchemaVersion } from "../src/shared-tech/storage.js";
import {
  THREAD_SCHEMA_VERSION_1,
  THREAD_SCHEMA_VERSION_2,
  THREAD_SCHEMA_VERSION_4,
  THREAD_SCHEMA_VERSION_5,
  THREAD_SCHEMA_VERSION_6,
  THREAD_SCHEMA_VERSION_7,
  THREAD_SCHEMA_VERSION_11,
} from "../src/shared-tech/thread-migrate.js";
import { openThreadDatabase } from "../src/threads/internal/create.js";
import {
  createInferenceCallbacksDouble,
  readDerivedForms,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;

beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

// Fresh threads are created at the current schema. Simulating an older file
// means stripping columns that that older version never had, so the migration
// step that adds them can run for real.
function stripV5HostFactColumns(db: DatabaseSync): void {
  db.exec("ALTER TABLE turns DROP COLUMN outcome;");
  db.exec("ALTER TABLE turns DROP COLUMN outcome_reason;");
  db.exec("ALTER TABLE turns DROP COLUMN started_at;");
  db.exec("ALTER TABLE turns DROP COLUMN ended_at;");
  db.exec("ALTER TABLE message DROP COLUMN provider_usage;");
}

function simulateV1Thread(filePath: string): void {
  const db = new DatabaseSync(filePath);
  try {
    stripV5HostFactColumns(db);
    addLegacyQueueColumns(db);
    db.exec("DROP TABLE IF EXISTS derivation_log;");
    db.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_1};`);
  } finally {
    db.close();
  }
}

function addLegacyQueueColumns(db: DatabaseSync): void {
  db.exec("ALTER TABLE work_item ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;");
  db.exec("ALTER TABLE work_item ADD COLUMN last_error TEXT;");
  db.exec("ALTER TABLE work_item ADD COLUMN eligible_at TEXT;");
  db.exec("ALTER TABLE work_item ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0;");
}

const receiptAccountWithPromptFilename = "edit packages/lhc/src/shared-tech/prompts/smooth-turn-compression-v1.ts";

function simulateV2ThreadWithOldDerivationNames(filePath: string): void {
  const metadata = JSON.stringify({
    receipts: [
      {
        messageId: "m1",
        activity: "tool_call",
        account: receiptAccountWithPromptFilename,
        outcome: "succeeded",
      },
    ],
    provenance: { provider: "openai-codex", model: "gpt-5.4-mini", prompt: "smooth-turn-compression-v1" },
  });
  const logPayload = JSON.stringify({
    reason: receiptAccountWithPromptFilename,
    provenance: { provider: "openai-codex", model: "gpt-5.4-mini", prompt: "smooth-turn-compression-v1" },
  });
  const db = new DatabaseSync(filePath);
  try {
    stripV5HostFactColumns(db);
    addLegacyQueueColumns(db);
    db.prepare(
      `INSERT INTO derivation
         (subject_kind, subject_id, derivation_type, state, content, source_version)
       VALUES ('turn', 't1', 'smooth_turn_compression', 'ready', 'legacy compression', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO derivation
         (subject_kind, subject_id, derivation_type, state, content, metadata, source_version)
       VALUES ('turn', 't2', 'smooth_turn_compression', 'ready', 'legacy with receipts', ?, 1)`,
    ).run(metadata);
    db.prepare(
      `INSERT INTO derivation_log
         (subject_kind, subject_id, derivation_type, event_kind, payload)
       VALUES ('turn', 't2', 'smooth_turn_compression', 'inference_succeeded', ?)`,
    ).run(logPayload);
    db.prepare(
      `INSERT INTO thread_view
         (singleton, view_id, created_at, compact_point, covered_from, profile_name,
          config_json, arrangement_json, gaps_json, source_state_json)
       VALUES (1, 'v1', '2026-01-01T00:00:00.000Z', 0, 0, NULL,
         '{}',
         '[{"band":"detailed","subjectKind":"turn","subjectId":"t1","derivationUsed":"smooth_turn_compression","degraded":false}]',
         '[{"subjectId":"t1","reason":"smooth_turn_compression pending"}]',
         '{"turns":{"t1":{"smooth_turn_compression":"ready"}}}')`,
    ).run();
    db.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_2};`);
  } finally {
    db.close();
  }
}

async function fixturePoisonedTurnDerivationWorkItem(
  filePath: string,
  opts: {
    downgradeToV2?: boolean;
    workStatus?: "queued" | "claimed";
    crashWindow?: boolean;
  } = {},
): Promise<void> {
  const result = await intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "migration drain test" } }),
    validEvent("assistant_text", { payload: { text: "migration answer" } }),
    validEvent("turn_end"),
  ]);
  if (!result.ok) throw new Error(`fixture intake failed: ${result.error.reason}`);

  const db = new DatabaseSync(filePath);
  try {
    const row = db.prepare(`SELECT payload FROM work_item WHERE kind = 'turn_derivation'`).get() as
      | { payload: string }
      | undefined;
    if (row === undefined) throw new Error("fixture invariant: turn_derivation work item expected");
    const payload = JSON.parse(row.payload) as { sourceVersion?: number; operation?: string };
    const sourceVersion = payload.sourceVersion ?? 1;
    const derivations = opts.crashWindow
      ? [
          { subjectKind: "turn", subjectId: "t1", derivationType: "turn_rendering" },
          { subjectKind: "turn", subjectId: "t1", derivationType: "pre_detailed_assembly" },
        ]
      : [
          { subjectKind: "turn", subjectId: "t1", derivationType: "turn_rendering" },
          { subjectKind: "turn", subjectId: "t1", derivationType: "detailed_turn_compression" },
        ];
    db.prepare(`UPDATE work_item SET payload = ? WHERE kind = 'turn_derivation'`).run(
      JSON.stringify({
        sourceVersion,
        operation: payload.operation,
        derivations,
      }),
    );
    db.prepare(`DELETE FROM derivation WHERE derivation_type = 'pre_detailed_assembly'`).run();
    if (!opts.crashWindow) {
      db.prepare(
        `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
         VALUES ('turn', 't1', 'detailed_turn_compression', 'pending', ?)
         ON CONFLICT (subject_kind, subject_id, derivation_type) DO UPDATE SET
           state = 'pending', content = NULL, reason = NULL, metadata = NULL,
           gaps = NULL, derived_at = NULL, source_version = excluded.source_version`,
      ).run(sourceVersion);
    }
    if (opts.workStatus === "claimed") {
      db.prepare(
        `UPDATE work_item
         SET status = 'claimed',
             claimed_at = '2020-01-01T00:00:00.000Z',
             claim_expires_at = '2020-01-01T00:00:00.000Z'
         WHERE kind = 'turn_derivation'`,
      ).run();
    }
    if (opts.downgradeToV2 === true) {
      stripV5HostFactColumns(db);
      addLegacyQueueColumns(db);
      db.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_2};`);
    }
  } finally {
    db.close();
  }
}

function formOf(filePath: string, derivationType: string) {
  return readDerivedForms(filePath).find((form) => form.subjectId === "t1" && form.derivationType === derivationType);
}

async function drainTurnDerivationsGreen(filePath: string): Promise<void> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({
    inferenceCallbacks: double,
    mode: "manual",
    lease: { durationMs: 200 },
  });
  const drain = await sdk.work.drain({ filePath });
  expect(drain.ok).toBe(true);
  if (!drain.ok) return;

  expect(formOf(filePath, "turn_rendering")).toMatchObject({ state: "ready" });
  expect(formOf(filePath, "pre_detailed_assembly")).toMatchObject({ state: "ready" });
  expect(formOf(filePath, "pre_detailed_assembly")?.content).toContain("User:\n");
  expect(formOf(filePath, "pre_detailed_assembly")?.content).toContain("⏺ ");
  expect(formOf(filePath, "detailed_turn_compression")).toMatchObject({ state: "ready" });

  const queueDb = new DatabaseSync(filePath, { readOnly: true });
  try {
    expect(
      (
        queueDb.prepare(`SELECT COUNT(*) AS count FROM work_item WHERE status IN ('queued', 'claimed')`).get() as {
          count: number | bigint;
        }
      ).count,
    ).toBe(0);
  } finally {
    queueDb.close();
  }
}

describe("thread schema migration", () => {
  it("opens a v1 thread file, migrates derivation_log, and preserves existing data", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const threadId = created.value.threadId;
    simulateV1Thread(filePath);

    const before = new DatabaseSync(filePath, { readOnly: true });
    try {
      expect(getSchemaVersion(before)).toBe(THREAD_SCHEMA_VERSION_1);
      expect(
        before.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'").get(),
      ).toBeUndefined();
    } finally {
      before.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'").get(),
      ).toBeDefined();
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_impression'").get(),
      ).toBeDefined();
      const metadata = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as
        | { thread_id: string }
        | undefined;
      expect(metadata?.thread_id).toBe(threadId);
      const turnCount = db.prepare("SELECT COUNT(*) AS count FROM turns").get() as { count: number | bigint };
      expect(Number(turnCount.count)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("migrates v2 derivation rows and stored view JSON from smooth_turn_compression to detailed_turn_compression", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    simulateV2ThreadWithOldDerivationNames(filePath);

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);
      const derivation = db
        .prepare(
          `SELECT derivation_type, content FROM derivation
           WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'detailed_turn_compression'`,
        )
        .get() as { derivation_type: string; content: string } | undefined;
      expect(derivation).toMatchObject({
        derivation_type: "detailed_turn_compression",
        content: "legacy compression",
      });
      expect(
        db.prepare(`SELECT 1 FROM derivation WHERE derivation_type = 'smooth_turn_compression'`).get(),
      ).toBeUndefined();

      const view = db
        .prepare(`SELECT arrangement_json, gaps_json, source_state_json FROM thread_view WHERE singleton = 1`)
        .get() as { arrangement_json: string; gaps_json: string; source_state_json: string };
      expect(view.arrangement_json).toContain('"derivationUsed":"detailed_turn_compression"');
      expect(view.arrangement_json).not.toContain("smooth_turn_compression");
      expect(view.gaps_json).toContain("detailed_turn_compression");
      expect(view.gaps_json).not.toContain("smooth_turn_compression");
      expect(view.source_state_json).toContain("detailed_turn_compression");
      expect(view.source_state_json).not.toContain("smooth_turn_compression");

      const migratedMetadata = db
        .prepare(
          `SELECT metadata FROM derivation
           WHERE subject_kind = 'turn' AND subject_id = 't2' AND derivation_type = 'detailed_turn_compression'`,
        )
        .get() as { metadata: string } | undefined;
      expect(migratedMetadata).toBeDefined();
      const parsedMetadata = JSON.parse(migratedMetadata!.metadata) as {
        receipts: Array<{ account: string }>;
        provenance: { prompt: string };
      };
      expect(parsedMetadata.receipts[0]?.account).toBe(receiptAccountWithPromptFilename);
      expect(parsedMetadata.provenance.prompt).toBe("detailed-turn-compression-v1");

      const migratedLog = db
        .prepare(
          `SELECT payload FROM derivation_log
           WHERE subject_kind = 'turn' AND subject_id = 't2' AND derivation_type = 'detailed_turn_compression'`,
        )
        .get() as { payload: string } | undefined;
      expect(migratedLog).toBeDefined();
      const parsedLogPayload = JSON.parse(migratedLog!.payload) as {
        reason: string;
        provenance: { prompt: string };
      };
      expect(parsedLogPayload.reason).toBe(receiptAccountWithPromptFilename);
      expect(parsedLogPayload.provenance.prompt).toBe("detailed-turn-compression-v1");
    } finally {
      db.close();
    }
  });

  it("normalizes queued old-shape turn_derivation items and drains cleanly end to end", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await fixturePoisonedTurnDerivationWorkItem(filePath, { downgradeToV2: true });

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);
      const payload = JSON.parse(
        (db.prepare(`SELECT payload FROM work_item WHERE kind = 'turn_derivation'`).get() as { payload: string })
          .payload,
      ) as { derivations: Array<{ derivationType: string }> };
      expect(payload.derivations.map((target) => target.derivationType).sort()).toEqual([
        "pre_detailed_assembly",
        "turn_rendering",
      ]);
      expect(
        (
          db
            .prepare(
              `SELECT state FROM derivation
               WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'`,
            )
            .get() as { state: string }
        ).state,
      ).toBe("pending");
    } finally {
      db.close();
    }

    await drainTurnDerivationsGreen(filePath);
  });

  it("normalizes a claimed old-shape item, then fails its expired lease without rerunning it", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await fixturePoisonedTurnDerivationWorkItem(filePath, { workStatus: "claimed" });

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = opened.value;
    try {
      const work = db.prepare(`SELECT status, payload FROM work_item WHERE kind = 'turn_derivation'`).get() as {
        status: string;
        payload: string;
      };
      expect(work.status).toBe("claimed");
      const payload = JSON.parse(work.payload) as { derivations: Array<{ derivationType: string }> };
      expect(payload.derivations.map((target) => target.derivationType).sort()).toEqual([
        "pre_detailed_assembly",
        "turn_rendering",
      ]);
      expect(
        (
          db
            .prepare(
              `SELECT state FROM derivation
               WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'`,
            )
            .get() as { state: string }
        ).state,
      ).toBe("pending");
    } finally {
      db.close();
    }

    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const drained = await sdk.work.drain({ filePath });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.value.ran).toContainEqual(
      expect.objectContaining({
        workItemId: "w-t1-turn_derivation-v1",
        disposition: "failed_terminal",
        reason: "claim_expired",
      }),
    );
    expect(formOf(filePath, "turn_rendering")).toMatchObject({ state: "failed", reason: "claim_expired" });
    expect(formOf(filePath, "pre_detailed_assembly")).toMatchObject({ state: "failed", reason: "claim_expired" });
  });

  it("heals a crash-window partial normalization on reopen (new-shape payload, missing assembly row)", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await fixturePoisonedTurnDerivationWorkItem(filePath, { crashWindow: true });

    const before = new DatabaseSync(filePath, { readOnly: true });
    try {
      const payload = JSON.parse(
        (before.prepare(`SELECT payload FROM work_item WHERE kind = 'turn_derivation'`).get() as { payload: string })
          .payload,
      ) as { derivations: Array<{ derivationType: string }> };
      expect(payload.derivations.some((target) => target.derivationType === "pre_detailed_assembly")).toBe(true);
      expect(
        before
          .prepare(
            `SELECT 1 FROM derivation
             WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      before.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = opened.value;
    try {
      expect(
        (
          db
            .prepare(
              `SELECT state FROM derivation
               WHERE subject_kind = 'turn' AND subject_id = 't1' AND derivation_type = 'pre_detailed_assembly'`,
            )
            .get() as { state: string }
        ).state,
      ).toBe("pending");
    } finally {
      db.close();
    }

    await drainTurnDerivationsGreen(filePath);
  });

  // Schema v5 (D4): add nullable turn host-fact + message provider_usage columns
  // with no backfill. Existing rows keep NULL in every new field.
  function simulateV4Thread(filePath: string): void {
    const db = new DatabaseSync(filePath);
    try {
      stripV5HostFactColumns(db);
      db.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_4};`);
    } finally {
      db.close();
    }
  }

  it("migrates a v4 file: adds nullable host-fact columns, preserves data, backfills nothing", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const intake = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "v4 migration prompt" } }),
      validEvent("assistant_text", { payload: { text: "v4 migration answer" } }),
      validEvent("turn_end"),
    ]);
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;

    const before = new DatabaseSync(filePath, { readOnly: true });
    let eventCount: number;
    let messageIds: string[];
    let turnIds: string[];
    try {
      eventCount = Number(
        (before.prepare("SELECT COUNT(*) AS count FROM event").get() as { count: number | bigint }).count,
      );
      messageIds = (
        before.prepare("SELECT message_id FROM message ORDER BY source_event_order").all() as Array<{
          message_id: string;
        }>
      ).map((row) => row.message_id);
      turnIds = (
        before.prepare("SELECT turn_id FROM turns ORDER BY turn_order").all() as Array<{ turn_id: string }>
      ).map((row) => row.turn_id);
      expect(eventCount).toBe(3);
      expect(messageIds).toEqual(["m1", "m2"]);
      expect(turnIds).toEqual(["t1", "t2"]);
    } finally {
      before.close();
    }

    simulateV4Thread(filePath);

    const preMigrate = new DatabaseSync(filePath, { readOnly: true });
    try {
      expect(getSchemaVersion(preMigrate)).toBe(THREAD_SCHEMA_VERSION_4);
      const turnCols = (preMigrate.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      const messageCols = (preMigrate.prepare("PRAGMA table_info(message)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      expect(turnCols).not.toContain("outcome");
      expect(turnCols).not.toContain("outcome_reason");
      expect(turnCols).not.toContain("started_at");
      expect(turnCols).not.toContain("ended_at");
      expect(messageCols).not.toContain("provider_usage");
    } finally {
      preMigrate.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);

      const turnCols = (db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>).map((row) => row.name);
      const messageCols = (db.prepare("PRAGMA table_info(message)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      expect(turnCols).toEqual(expect.arrayContaining(["outcome", "outcome_reason", "started_at", "ended_at"]));
      expect(messageCols).toContain("provider_usage");

      // All pre-migration rows keep NULL in every new field — no invented values.
      const turnRows = db
        .prepare(`SELECT turn_id, outcome, outcome_reason, started_at, ended_at FROM turns ORDER BY turn_order`)
        .all() as Array<{
        turn_id: string;
        outcome: string | null;
        outcome_reason: string | null;
        started_at: string | null;
        ended_at: string | null;
      }>;
      expect(turnRows.map((row) => row.turn_id)).toEqual(turnIds);
      for (const row of turnRows) {
        expect(row.outcome).toBeNull();
        expect(row.outcome_reason).toBeNull();
        expect(row.started_at).toBeNull();
        expect(row.ended_at).toBeNull();
      }

      const messageRows = db
        .prepare(`SELECT message_id, provider_usage FROM message ORDER BY source_event_order`)
        .all() as Array<{ message_id: string; provider_usage: string | null }>;
      expect(messageRows.map((row) => row.message_id)).toEqual(messageIds);
      for (const row of messageRows) {
        expect(row.provider_usage).toBeNull();
      }

      // Existing record content is intact.
      expect(
        Number((db.prepare("SELECT COUNT(*) AS count FROM event").get() as { count: number | bigint }).count),
      ).toBe(eventCount);
      const prompt = db
        .prepare(`SELECT content FROM message_block WHERE message_id = 'm1' AND block_index = 0`)
        .get() as { content: string };
      expect(JSON.parse(prompt.content)).toEqual({ text: "v4 migration prompt" });
    } finally {
      db.close();
    }
  });

  it("migrates a genuine v5 file by creating the retrieval impression table and indexes", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const old = new DatabaseSync(filePath);
    try {
      old.exec("DROP TABLE retrieval_impression;");
      old.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_5};`);
      expect(
        old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_impression'").get(),
      ).toBeUndefined();
    } finally {
      old.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_impression'").get(),
      ).toBeDefined();
      const indexes = (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_retrieval_impression_%' ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toEqual(["idx_retrieval_impression_call", "idx_retrieval_impression_entity"]);
    } finally {
      db.close();
    }
  });

  it("migrates a genuine v6 file by creating compact-continuation writer and receipt tables", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const old = new DatabaseSync(filePath);
    try {
      old.exec("DROP TABLE IF EXISTS compact_continuation_stage_log;");
      old.exec("DROP TABLE IF EXISTS compact_continuation_boundary;");
      old.exec("DROP TABLE compact_continuation_receipt;");
      old.exec("DROP TABLE compact_continuation_writer;");
      old.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_6};`);
      expect(
        old
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_writer'")
          .get(),
      ).toBeUndefined();
    } finally {
      old.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_writer'")
          .get(),
      ).toBeDefined();
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_receipt'")
          .get(),
      ).toBeDefined();
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_boundary'")
          .get(),
      ).toBeDefined();
      const claim = db.prepare(`SELECT claim FROM compact_continuation_writer WHERE singleton = 1`).get() as {
        claim: string;
      };
      expect(claim.claim).toBe("none");
      // v8 receipt has terminal column
      const cols = db.prepare(`PRAGMA table_info(compact_continuation_receipt)`).all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("terminal");
    } finally {
      db.close();
    }
  });

  it("migrates a genuine v7 file by adding boundary/stage tables and terminal receipts", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const old = new DatabaseSync(filePath);
    try {
      // Strip v8 tables and rebuild v7 receipt shape.
      old.exec("DROP TABLE IF EXISTS compact_continuation_stage_log;");
      old.exec("DROP TABLE IF EXISTS compact_continuation_boundary;");
      old.exec("DROP TABLE compact_continuation_receipt;");
      old.exec(`CREATE TABLE compact_continuation_receipt (
        attempt_id TEXT PRIMARY KEY,
        recorded_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        refused INTEGER NOT NULL,
        skipped INTEGER NOT NULL,
        continuation_turn_id TEXT,
        receipt_json TEXT NOT NULL,
        decision_json TEXT NOT NULL
      );`);
      old
        .prepare(
          `INSERT INTO compact_continuation_receipt
           (attempt_id, recorded_at, outcome, reason_code, refused, skipped, continuation_turn_id, receipt_json, decision_json)
           VALUES ('a1', '2026-01-01T00:00:00.000Z', 'continue_normal', 'below_trigger', 0, 0, NULL, '{}', '{}')`,
        )
        .run();
      old.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_7};`);
    } finally {
      old.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);
      const row = db
        .prepare(`SELECT attempt_id, terminal FROM compact_continuation_receipt WHERE attempt_id = 'a1'`)
        .get() as { attempt_id: string; terminal: number };
      expect(row.attempt_id).toBe("a1");
      expect(Number(row.terminal)).toBe(1);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_boundary'")
          .get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("migrates a genuine v8 file by adding attempt intent and force intent tables", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const old = new DatabaseSync(filePath);
    try {
      old.exec("DROP TABLE IF EXISTS compact_continuation_attempt;");
      old.exec("DROP TABLE IF EXISTS compact_continuation_force_intent;");
      old.exec(`PRAGMA user_version = 8;`);
      expect(
        old
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_attempt'")
          .get(),
      ).toBeUndefined();
    } finally {
      old.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_attempt'")
          .get(),
      ).toBeDefined();
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_continuation_force_intent'")
          .get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("migrates a genuine v9 file by adding one-unresolved boundary index", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const old = new DatabaseSync(filePath);
    try {
      old.exec("DROP INDEX IF EXISTS idx_compact_continuation_boundary_one_unresolved;");
      old.exec(`PRAGMA user_version = 9;`);
      expect(
        old
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_compact_continuation_boundary_one_unresolved'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      old.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_11);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_compact_continuation_boundary_one_unresolved'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("v9→v10 migration refuses multiple unresolved boundaries", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const old = new DatabaseSync(filePath);
    try {
      old.exec("DROP INDEX IF EXISTS idx_compact_continuation_boundary_one_unresolved;");
      old
        .prepare(
          `INSERT INTO compact_continuation_boundary (
           continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
         ) VALUES
           ('t-a', 'a1', 'pending', 0, 'x', '2020-01-01T00:00:00.000Z', NULL),
           ('t-b', 'a2', 'failed_repairable', 0, 'y', '2020-01-02T00:00:00.000Z', NULL)`,
        )
        .run();
      old.exec(`PRAGMA user_version = 9;`);
    } finally {
      old.close();
    }

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe("storage_failure");
    expect(opened.error.reason).toMatch(/unresolved boundaries|migration/i);
  });
});
