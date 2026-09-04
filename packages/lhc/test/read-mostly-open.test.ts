/**
 * LIM-133: current-schema opens are read-mostly.
 *
 * The queued turn_derivation repair is a recurring mixed-version crash-window
 * repair, not a once-only migration, so it keeps running on every open — but
 * only after a read-only predicate says there is something to repair. With no
 * matching work the open takes no write transaction at all.
 *
 * `PRAGMA query_only = ON` is the instrument: it turns any write attempt,
 * `BEGIN IMMEDIATE` included, into an immediate "attempt to write a readonly
 * database" error. A migration pass that completes under query_only provably
 * wrote nothing.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { intakeStream, threads } from "../src/index.js";
import { migrateThreadSchema } from "../src/shared-tech/thread-migrate.js";
import { openThreadDatabase } from "../src/threads/internal/create.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

let store: TempStore;

beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

/** Runs the current-schema migration under a connection that cannot write. */
function migrateUnderQueryOnly(filePath: string): { wrote: boolean; detail: string } {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA query_only = ON;");
    migrateThreadSchema(db);
    return { wrote: false, detail: "" };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (!detail.includes("readonly database")) throw cause;
    return { wrote: true, detail };
  } finally {
    db.close();
  }
}

async function threadWithOneTurn(): Promise<string> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  const recorded = await intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "q" } }),
    validEvent("assistant_text", { payload: { text: "a" } }),
    validEvent("turn_end"),
  ]);
  if (!recorded.ok) throw new Error(recorded.error.reason);
  return filePath;
}

interface PoisonOptions {
  status?: "queued" | "claimed" | "done";
  turnId?: string;
  workItemId?: string;
  payload?: unknown;
  dropAssemblyRow?: boolean;
}

/** Rewrites a work item back to the pre-rewire (legacy) turn_derivation shape. */
function poisonTurnDerivationItem(filePath: string, opts: PoisonOptions = {}): void {
  const db = new DatabaseSync(filePath);
  try {
    const turnId = opts.turnId ?? "t1";
    const row = db
      .prepare(`SELECT work_item_id, payload FROM work_item WHERE kind = 'turn_derivation' LIMIT 1`)
      .get() as { work_item_id: string; payload: string } | undefined;
    if (row === undefined) throw new Error("fixture invariant: a turn_derivation work item must exist");
    const existing = JSON.parse(row.payload) as { sourceVersion?: number; operation?: string };
    const payload =
      opts.payload ??
      JSON.stringify({
        sourceVersion: existing.sourceVersion ?? 1,
        operation: existing.operation,
        derivations: [
          { subjectKind: "turn", subjectId: turnId, derivationType: "turn_rendering" },
          { subjectKind: "turn", subjectId: turnId, derivationType: "detailed_turn_compression" },
        ],
      });
    const workItemId = opts.workItemId ?? row.work_item_id;
    if (workItemId === row.work_item_id) {
      db.prepare(`UPDATE work_item SET payload = ?, status = ? WHERE work_item_id = ?`).run(
        typeof payload === "string" ? payload : JSON.stringify(payload),
        opts.status ?? "queued",
        workItemId,
      );
    } else {
      db.prepare(
        `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
         VALUES (?, 'turns', 'turn_derivation', ?, ?, '2020-01-01T00:00:00.000Z', ?)`,
      ).run(
        workItemId,
        JSON.stringify({ turnId }),
        opts.status ?? "queued",
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
    }
    if (opts.dropAssemblyRow !== false) {
      db.prepare(`DELETE FROM derivation WHERE subject_id = ? AND derivation_type = 'pre_detailed_assembly'`).run(
        turnId,
      );
    }
  } finally {
    db.close();
  }
}

function readWorkItem(filePath: string, workItemId: string): { status: string; payload: string } {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return db.prepare(`SELECT status, payload FROM work_item WHERE work_item_id = ?`).get(workItemId) as {
      status: string;
      payload: string;
    };
  } finally {
    db.close();
  }
}

function assemblyRows(filePath: string, turnId: string): Array<{ state: string; source_version: number }> {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT state, source_version FROM derivation
         WHERE subject_kind = 'turn' AND subject_id = ? AND derivation_type = 'pre_detailed_assembly'`,
      )
      .all(turnId) as Array<{ state: string; source_version: number }>;
  } finally {
    db.close();
  }
}

describe("current-schema open with no repairable work", () => {
  it("takes no write transaction on a freshly created thread", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(false);
  });

  it("takes no write transaction on a thread with ordinary queued derivation work", async () => {
    const filePath = await threadWithOneTurn();
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(false);
  });

  it("takes no write transaction when the only legacy-shaped item is already done", async () => {
    const filePath = await threadWithOneTurn();
    poisonTurnDerivationItem(filePath, { status: "done" });
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(false);
  });

  it("opens normally while another connection holds the write lock", async () => {
    const filePath = await threadWithOneTurn();
    const writer = new DatabaseSync(filePath);
    writer.exec("BEGIN IMMEDIATE;");
    try {
      const opened = openThreadDatabase(filePath);
      expect(opened.ok, opened.ok ? "" : opened.error.reason).toBe(true);
      if (opened.ok) opened.value.close();
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
  });
});

describe("current-schema open with matching legacy work", () => {
  it("repairs a queued row exactly once and then stops writing", async () => {
    const filePath = await threadWithOneTurn();
    poisonTurnDerivationItem(filePath, { status: "queued" });

    // The predicate says there is work: the open takes the write transaction.
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(true);

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.value.close();

    const seeded = assemblyRows(filePath, "t1");
    expect(seeded.length).toBe(1);
    expect(seeded[0]?.state).toBe("pending");
    const repaired = readWorkItem(filePath, "w-t1-turn_derivation-v1");
    const derivationTypes = (
      JSON.parse(repaired.payload) as { derivations: Array<{ derivationType: string }> }
    ).derivations.map((target) => target.derivationType);
    expect(derivationTypes).toEqual(["turn_rendering", "pre_detailed_assembly"]);

    // Second and third opens find nothing to do and write nothing.
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(false);
    const reopened = openThreadDatabase(filePath);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) reopened.value.close();
    expect(assemblyRows(filePath, "t1").length).toBe(1);
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(false);
  });

  it("repairs a claimed row the same way", async () => {
    const filePath = await threadWithOneTurn();
    poisonTurnDerivationItem(filePath, { status: "claimed" });
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(true);
    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.value.close();
    expect(assemblyRows(filePath, "t1").length).toBe(1);
    expect(readWorkItem(filePath, "w-t1-turn_derivation-v1").status).toBe("claimed");
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(false);
  });

  it("seeds only the matching item when matching and non-matching rows are mixed", async () => {
    const filePath = await threadWithOneTurn();
    // A second turn's item stays in the current shape with its assembly row.
    const db = new DatabaseSync(filePath);
    try {
      db.prepare(
        `INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order) VALUES ('t9', 9, 'open', 0)`,
      ).run();
      db.prepare(
        `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
         VALUES ('w-t9', 'turns', 'turn_derivation', ?, 'queued', '2020-01-01T00:00:00.000Z', ?)`,
      ).run(
        JSON.stringify({ turnId: "t9" }),
        JSON.stringify({
          sourceVersion: 1,
          operation: "derive",
          derivations: [
            { subjectKind: "turn", subjectId: "t9", derivationType: "turn_rendering" },
            { subjectKind: "turn", subjectId: "t9", derivationType: "pre_detailed_assembly" },
          ],
        }),
      );
      db.prepare(
        `INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, source_version)
         VALUES ('turn', 't9', 'pre_detailed_assembly', 'pending', 1)`,
      ).run();
    } finally {
      db.close();
    }
    poisonTurnDerivationItem(filePath, { status: "queued" });

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.value.close();

    expect(assemblyRows(filePath, "t1").length).toBe(1);
    expect(assemblyRows(filePath, "t9").length).toBe(1);
    // t9's payload was already current: it is untouched.
    const t9 = JSON.parse(readWorkItem(filePath, "w-t9").payload) as {
      derivations: Array<{ derivationType: string }>;
    };
    expect(t9.derivations.map((target) => target.derivationType)).toEqual(["turn_rendering", "pre_detailed_assembly"]);
    expect(migrateUnderQueryOnly(filePath).wrote).toBe(false);
  });

  it("reports a malformed legacy payload as a storage failure, as before", async () => {
    const filePath = await threadWithOneTurn();
    poisonTurnDerivationItem(filePath, { status: "queued", payload: "{ not json" });
    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.errorClass).toBe("system_error");
    expect(opened.error.code).toBe("storage_failure");
    expect(opened.error.reason).toContain("could not open thread file");
  });
});
