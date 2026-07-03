import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLhc, intakeStream, threads } from "../src/index.js";
import { getSchemaVersion } from "../src/shared-tech/storage.js";
import {
  THREAD_SCHEMA_VERSION_1,
  THREAD_SCHEMA_VERSION_2,
  THREAD_SCHEMA_VERSION_3,
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

function simulateV1Thread(filePath: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("DROP TABLE IF EXISTS derivation_log;");
    db.exec(`PRAGMA user_version = ${THREAD_SCHEMA_VERSION_1};`);
  } finally {
    db.close();
  }
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
             claim_expires_at = '2020-01-01T00:00:00.000Z',
             claim_epoch = 1
         WHERE kind = 'turn_derivation'`,
      ).run();
    }
    if (opts.downgradeToV2 === true) {
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
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
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
      expect(getSchemaVersion(db)).toBe(3);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'derivation_log'").get(),
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
      expect(getSchemaVersion(db)).toBe(3);
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
      expect(getSchemaVersion(db)).toBe(THREAD_SCHEMA_VERSION_3);
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

  it("normalizes claimed old-shape turn_derivation items with expired leases and drains cleanly", async () => {
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

    await drainTurnDerivationsGreen(filePath);
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
});
