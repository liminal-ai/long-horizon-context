// F-03-001: an existing valid Story 2 thread file (user_version=1, only
// thread_metadata/event tables) must be migrated to the current schema before
// any Story 3 message write or read. The fixture reproduces the accepted
// Story 2 on-disk layout exactly; the assertions go through the production
// entry points (messageEvents, listMessages, listEvents) plus below-SDK
// schema-version reads.
// F-03-002: the lazy opener must reject existing files that are not thread
// files without creating lhc schema or bumping user_version on them.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intakeStream, messages, turns } from "../src/index.js";
import {
  legacyEpic01ThreadFile,
  legacyEpic02ThreadFile,
  legacyStory2ThreadFile,
  openRaw,
  readDerivedForms,
  schemaVersionOf,
  tempStore,
  validEvent,
  type TempStore,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const legacyEvent = {
  eventOrder: 1,
  eventKind: "user_prompt",
  idempotencyKey: "legacy-key-1",
  actor: "legacy-actor",
  harness: "legacy-harness",
  payload: { text: "recorded before story 3 shipped" },
  recordedAt: "2026-06-01T00:00:01.000Z",
};

describe("F-03-001: Story 2 thread files migrate before message write/read", () => {
  it("messageEvents on a Story 2 file upgrades the schema, keeps the legacy record intact, and projects the new events", async () => {
    const filePath = store.threadPath();
    legacyStory2ThreadFile(filePath, "th_legacy01", [legacyEvent]);
    expect(schemaVersionOf(filePath)).toBe(1);

    const result = await intakeStream.messageEvents({ filePath }, [
      validEvent("assistant_text", { payload: { text: "answered after upgrade" } }),
      validEvent("turn_end"),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events.map((entry) => entry.outcome)).toEqual([
      "recorded",
      "recorded",
    ]);
    // The order counter continues from the legacy record; the new message id
    // derives from the continued order.
    expect(result.value.threadPosition.lastEventOrder).toBe(3);
    expect(result.value.events[0]!.messageId).toBe("m2");

    expect(schemaVersionOf(filePath)).toBe(6);

    // The legacy event survives the upgrade byte-for-byte at the SDK level.
    const events = await intakeStream.listEvents({ filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(3);
    expect(events.value[0]).toEqual({
      eventKind: "user_prompt",
      idempotencyKey: "legacy-key-1",
      actor: "legacy-actor",
      harness: "legacy-harness",
      payload: { text: "recorded before story 3 shipped" },
      eventOrder: 1,
      recordedAt: "2026-06-01T00:00:01.000Z",
    });

    // Projection is intake-time, not retroactive: the new assistant_text
    // projects; the legacy pre-Story-3 event stays event-only.
    const projected = await messages.listMessages({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value).toHaveLength(1);
    expect(projected.value[0]!.messageId).toBe("m2");
    expect(projected.value[0]!.sourceEventOrder).toBe(2);
    expect(projected.value[0]!.blocks).toEqual([
      { blockType: "text", content: { text: "answered after upgrade" } },
    ]);
    expect(projected.value[0]!.tokenEstimate).toBeGreaterThan(0);
  });

  it("listMessages on an untouched Story 2 file migrates on read and returns an empty list", async () => {
    const filePath = store.threadPath();
    legacyStory2ThreadFile(filePath, "th_legacy02", [legacyEvent]);
    expect(schemaVersionOf(filePath)).toBe(1);

    const projected = await messages.listMessages({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value).toEqual([]);

    expect(schemaVersionOf(filePath)).toBe(6);

    // The read-path upgrade changed no record content.
    const events = await intakeStream.listEvents({ filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(1);
    expect(events.value[0]!.idempotencyKey).toBe("legacy-key-1");
  });

  it("idempotency keys recorded under Story 2 still skip after the upgrade", async () => {
    const filePath = store.threadPath();
    legacyStory2ThreadFile(filePath, "th_legacy03", [legacyEvent]);

    const resend = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", {
        idempotencyKey: "legacy-key-1",
        payload: { text: "resent after upgrade" },
      }),
    ]);
    expect(resend.ok).toBe(true);
    if (!resend.ok) return;
    expect(resend.value.events[0]).toEqual({
      idempotencyKey: "legacy-key-1",
      outcome: "skipped",
      skipReason: "duplicate_idempotency_key",
    });

    // No message was created for the skipped resend of the legacy event.
    const projected = await messages.listMessages({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value).toEqual([]);
  });
});

// Tables present in a file, by name — asserts what schema (if any) the
// rejected open left behind.
function tableNames(filePath: string): string[] {
  const db = openRaw(filePath);
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

describe("F-03-002: non-thread files are rejected, not adopted", () => {
  it("listMessages against an existing empty database file fails without creating schema or bumping user_version", async () => {
    const filePath = store.threadPath();
    writeFileSync(filePath, ""); // exists, zero bytes — a valid empty SQLite database

    const result = await messages.listMessages({ filePath });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("thread_not_found");
    expect(result.error.reason).toContain("not an lhc thread file");

    expect(schemaVersionOf(filePath)).toBe(0);
    expect(tableNames(filePath)).toEqual([]);
  });

  it("messageEvents against an unrelated SQLite database fails and leaves its content untouched", async () => {
    const filePath = store.threadPath();
    const foreign = openRaw(filePath);
    try {
      foreign.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);");
      foreign.prepare("INSERT INTO notes (id, body) VALUES (1, ?)").run("not lhc data");
    } finally {
      foreign.close();
    }

    const result = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("thread_not_found");
    expect(result.error.reason).toContain("not an lhc thread file");

    // No lhc tables were created, the version was not bumped, and the
    // foreign data is intact.
    expect(schemaVersionOf(filePath)).toBe(0);
    expect(tableNames(filePath)).toEqual(["notes"]);
    const db = openRaw(filePath);
    try {
      const row = db.prepare("SELECT body FROM notes WHERE id = 1").get() as unknown as {
        body: string;
      };
      expect(row.body).toBe("not lhc data");
    } finally {
      db.close();
    }
  });

  it("a non-SQLite file is rejected as a caller error with its bytes unchanged", async () => {
    const filePath = store.threadPath();
    const original = "just some text, definitely not a database\n";
    writeFileSync(filePath, original);

    const listed = await messages.listMessages({ filePath });
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error.errorClass).toBe("caller_error");
    expect(listed.error.code).toBe("thread_not_found");

    const batched = await intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
    expect(batched.ok).toBe(false);
    if (batched.ok) return;
    expect(batched.error.errorClass).toBe("caller_error");
    expect(batched.error.code).toBe("thread_not_found");

    expect(readFileSync(filePath, "utf8")).toBe(original);
  });
});

// Story 0 (Epic 02), FC-0.5 + architecture risk "migration on live data":
// v5 applies in place to a populated Epic 01 file — existing rows intact,
// new columns defaulted, the F-02 backfill creating pending derived_form
// rows for live queued items. A fresh-file migration test would pass while
// breaking real threads; this one runs over real Epic 01 data.
describe("FC-0.5: migration v5 over a populated Epic 01 thread file", () => {
  it("upgrades in place: records intact, queue columns defaulted, F-02 backfill pending rows present", async () => {
    const filePath = store.threadPath();
    legacyEpic01ThreadFile(filePath, "th_epic01");
    expect(schemaVersionOf(filePath)).toBe(4);

    // Any SDK read migrates lazily; the read itself must succeed post-v5.
    const projected = await messages.listMessages({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(schemaVersionOf(filePath)).toBe(6);

    // Existing records intact through the production read surfaces.
    expect(projected.value.map((m) => m.messageId)).toEqual(["m1", "m2", "m3"]);
    const events = await intakeStream.listEvents({ filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(4);
    const turnRecords = await turns.listTurns({ filePath });
    expect(turnRecords.ok).toBe(true);
    if (!turnRecords.ok) return;
    expect(turnRecords.value).toEqual([
      {
        turnId: "t1",
        status: "closed",
        memberMessageIds: ["m1", "m2", "m3"],
        openedAtEventOrder: 1,
        closedAtEventOrder: 4,
        forms: [
          {
            subjectKind: "turn",
            subjectId: "t1",
            form: "lower_band_projection",
            state: "pending",
            sourceVersion: 1,
          },
          {
            subjectKind: "turn",
            subjectId: "t1",
            form: "turn_rendering",
            state: "pending",
            sourceVersion: 1,
          },
        ],
      },
    ]);

    // Work rows survive with their pre-v5 ids; the queue's mechanical
    // columns exist and default to not-claimed / immediately eligible.
    const db = openRaw(filePath);
    try {
      const items = db
        .prepare(
          `SELECT work_item_id, status, attempts, last_error, claimed_at,
                  claim_expires_at, eligible_at, payload
           FROM work_item ORDER BY work_item_id`,
        )
        .all() as unknown as Array<Record<string, unknown>>;
      expect(items.map((row) => row.work_item_id)).toEqual([
        "w-m1-prompt_smoothing",
        "w-m3-tool_result_summary",
        "w-t1-turn_derivation",
      ]);
      for (const row of items) {
        expect(row.status).toBe("queued");
        expect(Number(row.attempts)).toBe(0);
        expect(row.last_error).toBeNull();
        expect(row.claimed_at).toBeNull();
        expect(row.claim_expires_at).toBeNull();
        expect(row.eligible_at).toBeNull();
        expect(row.payload).toBeNull();
      }
      // The epic's other v5 surfaces exist (schema ships whole): chunk
      // tables empty, deleted_at stamps present and null.
      const chunkCount = db.prepare("SELECT COUNT(*) AS n FROM chunk").get() as { n: number | bigint };
      expect(Number(chunkCount.n)).toBe(0);
      const deleted = db
        .prepare("SELECT COUNT(*) AS n FROM message WHERE deleted_at IS NOT NULL")
        .get() as { n: number | bigint };
      expect(Number(deleted.n)).toBe(0);
    } finally {
      db.close();
    }

    // F-02 backfill: one pending row per live queued item, mapped per kind —
    // turn_derivation fans out to both turn forms; all at source version 1.
    expect(
      readDerivedForms(filePath).map(({ subjectKind, subjectId, form, state, sourceVersion }) => ({
        subjectKind,
        subjectId,
        form,
        state,
        sourceVersion,
      })),
    ).toEqual([
      { subjectKind: "message", subjectId: "m1", form: "smoothed_prompt", state: "pending", sourceVersion: 1 },
      { subjectKind: "message", subjectId: "m3", form: "tool_result_summary", state: "pending", sourceVersion: 1 },
      { subjectKind: "turn", subjectId: "t1", form: "lower_band_projection", state: "pending", sourceVersion: 1 },
      { subjectKind: "turn", subjectId: "t1", form: "turn_rendering", state: "pending", sourceVersion: 1 },
    ]);

    // The migrated file keeps working through the Epic 01 write path: a new
    // batch records, projects, and queues against the v5 schema.
    const batch = await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "recorded after the upgrade" } }),
      validEvent("turn_end"),
    ]);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value.events.map((entry) => entry.outcome)).toEqual(["recorded", "recorded"]);
    expect(batch.value.queuedWork.map((item) => item.workItemId)).toEqual([
      "w-m5-prompt_smoothing-v1",
      "w-t2-turn_derivation-v1",
    ]);
  });
});

// Epic 03 Story 0, FC-0.1: migration v6 applies cleanly to an Epic-02 thread
// file through the real chain (the same lazy open every SDK operation uses).
// All three view tables exist with their CHECK constraints, the boundary is
// seeded at position 0, and re-applying is a no-op.
describe("FC-0.1 (Epic 03): migration v6 over a populated Epic 02 thread file", () => {
  it("upgrades in place, seeds the boundary singleton at 0, and re-applies as a no-op", async () => {
    const filePath = store.threadPath();
    legacyEpic02ThreadFile(filePath, "th_epic02");
    expect(schemaVersionOf(filePath)).toBe(5);

    // Any SDK read migrates lazily; the read itself must succeed post-v6.
    const projected = await messages.listMessages({ filePath });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(schemaVersionOf(filePath)).toBe(6);

    // The Epic 02 record is intact through the production read surface.
    expect(projected.value.map((m) => m.messageId)).toEqual(["m1", "m2", "m3"]);

    const db = openRaw(filePath);
    let boundaryBefore: { position: number; updatedAt: string };
    try {
      const names = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table'
             AND name IN ('thread_view', 'thread_view_band', 'view_boundary') ORDER BY name`,
          )
          .all() as unknown as Array<{ name: string }>
      ).map((row) => row.name);
      expect(names).toEqual(["thread_view", "thread_view_band", "view_boundary"]);

      // CHECK constraints are present and enforced: the view and boundary
      // singletons refuse any row outside their pinned key, and the band
      // table pins its band vocabulary (failed inserts mutate nothing).
      expect(() =>
        db
          .prepare(
            `INSERT INTO thread_view (singleton, view_id, created_at, compact_point,
               covered_from, config_json, arrangement_json, gaps_json, source_state_json)
             VALUES (2, 'v9', 'now', 0, 0, '{}', '[]', '[]', '{}')`,
          )
          .run(),
      ).toThrow(/CHECK/);
      const viewDdl = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'thread_view_band'`).get() as {
          sql: string;
        }
      ).sql;
      expect(viewDdl).toContain("CHECK (band IN ('brief','detailed','smooth'))");

      const rows = db
        .prepare(`SELECT thread_singleton, position, updated_at FROM view_boundary`)
        .all() as unknown as Array<{
        thread_singleton: number | bigint;
        position: number | bigint;
        updated_at: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.thread_singleton)).toBe(1);
      expect(Number(rows[0]!.position)).toBe(0);
      boundaryBefore = { position: Number(rows[0]!.position), updatedAt: rows[0]!.updated_at };
      expect(() =>
        db
          .prepare(`INSERT INTO view_boundary (thread_singleton, position, updated_at) VALUES (2, 0, 'now')`)
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }

    // Re-applying is a no-op: another open neither bumps the version nor
    // re-runs the seed (the boundary row is byte-identical, still singular).
    const reread = await messages.listMessages({ filePath });
    expect(reread.ok).toBe(true);
    expect(schemaVersionOf(filePath)).toBe(6);
    const again = openRaw(filePath);
    try {
      const rows = again
        .prepare(`SELECT thread_singleton, position, updated_at FROM view_boundary`)
        .all() as unknown as Array<{
        thread_singleton: number | bigint;
        position: number | bigint;
        updated_at: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.position)).toBe(boundaryBefore.position);
      expect(rows[0]!.updated_at).toBe(boundaryBefore.updatedAt);
    } finally {
      again.close();
    }
  });
});
