/**
 * Parent-owned asynchronous-work records (tech-design D4, LIM-145).
 *
 * The stable cc-lhc parent and its SQLite database own the identity and
 * lifecycle of every piece of asynchronous work a managed session launches.
 * A Claude child is a client of these rows: it can be replaced by Smart
 * Compact without the work losing its identity, its verified state, or the
 * operations the parent may perform on it.
 *
 * The schema lives in the existing cc-lhc database beside the governor and
 * handoff receipts — one file, one authority, no second store.
 *
 * Writes are monotonic:
 *  - one row per launch identity; a launch that is already recorded is not
 *    rewritten, and a terminal row never reopens;
 *  - `terminal` is absorbing: the first terminal evidence wins, later
 *    evidence for the same item is ignored;
 *  - the continuity generation on a row only increases, stamped by each
 *    accepted snapshot that carries it;
 *  - the per-thread generation counter only increases.
 *
 * Elapsed time is never an input: nothing here reads a clock to decide state.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defaultLineageDbPath } from "../intake/paths.js";
import type { AsyncWorkFamily } from "../observation/async-work.js";

export const CONTINUITY_BUSY_TIMEOUT_MS = 10_000;

export type ContinuityState = "active" | "terminal" | "unknown";

/**
 * How a family adapter carries an item across a child replacement. The
 * foundation records every launch as `unqualified` — a truthful "no adapter
 * has proven this yet" — and only a qualified adapter may change it.
 */
export type CarryMode = "adopt" | "reconstruct" | "rearm" | "unqualified";

/** The modes a qualified adapter may declare. `unqualified` is the launch default only. */
export type QualifiedCarryMode = Exclude<CarryMode, "unqualified">;

/** Management operations the parent can perform on an item through its adapter. */
export type ContinuityOperation = "status" | "output" | "stop";
const OPERATIONS: readonly ContinuityOperation[] = ["status", "output", "stop"];

export type TerminalOutcome = "completed" | "failed" | "timed_out" | "cancelled" | "killed" | "stopped" | "unknown";
const TERMINAL_OUTCOMES: readonly TerminalOutcome[] = [
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "killed",
  "stopped",
  "unknown",
];

export interface TerminalEvidence {
  outcome: TerminalOutcome;
  /** What the record said, e.g. `task-notification completed`, `TaskStop`. */
  evidence: string;
  observedAtMs: number;
}

export interface ContinuityItem {
  threadId: string;
  /** Stable logical identity of one launch: `family:key:toolUseId`. */
  launchId: string;
  /** Continuity generation of the last accepted snapshot that carried it; 0 before any. */
  generation: number;
  family: AsyncWorkFamily;
  /** Sanitized operator-facing label: never a command body, output, or progress text. */
  label: string;
  state: ContinuityState;
  carryMode: CarryMode;
  operations: readonly ContinuityOperation[];
  taskId: string | null;
  toolUseId: string | null;
  scheduledForMs: number | null;
  terminal: TerminalEvidence | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export type GenerationState = "open" | "closed" | "superseded";

/** One accepted snapshot: the set of launches a handoff generation carries. */
export interface ContinuityGeneration {
  threadId: string;
  generation: number;
  oldSessionId: string;
  launchIds: readonly string[];
  state: GenerationState;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ContinuityStoreDeps {
  openDbFn?: (path: string) => DatabaseSync;
  mkdirFn?: (path: string) => void;
}

export interface RecordLaunchInput {
  threadId: string;
  launchId: string;
  family: AsyncWorkFamily;
  label: string;
  taskId?: string;
  toolUseId?: string;
  scheduledForMs?: number;
  nowMs: number;
}

export interface ContinuityStore {
  readonly path: string;
  /** Open one item per launch identity. An existing row (any state) is returned unchanged. */
  recordLaunch(input: RecordLaunchInput): { item: ContinuityItem; inserted: boolean };
  /** Progress refreshes an open item and closes nothing. Returns null for an unknown launch. */
  recordProgress(input: { threadId: string; launchId: string; nowMs: number }): ContinuityItem | null;
  /** First terminal evidence closes the item; later evidence is ignored (`applied: false`). */
  recordTerminal(input: {
    threadId: string;
    launchId: string;
    outcome: TerminalOutcome;
    evidence: string;
    nowMs: number;
  }): { item: ContinuityItem; applied: boolean } | null;
  /** Verification result for a non-terminal item: `active` when verified, `unknown` when not. */
  setVerified(input: { threadId: string; launchId: string; verified: boolean; nowMs: number }): ContinuityItem | null;
  /** A qualified adapter declares how it carries the item and what it can do to it. Never back to `unqualified`. */
  setCarryMode(input: {
    threadId: string;
    launchId: string;
    carryMode: QualifiedCarryMode;
    operations: readonly ContinuityOperation[];
    nowMs: number;
  }): ContinuityItem | null;
  getItem(threadId: string, launchId: string): ContinuityItem | null;
  /** Every item of the thread in launch order. */
  listItems(threadId: string): ContinuityItem[];
  /** Allocate the next generation for the thread and stamp its members. Earlier open generations are superseded. */
  allocateGeneration(input: {
    threadId: string;
    oldSessionId: string;
    launchIds: readonly string[];
    nowMs: number;
  }): ContinuityGeneration;
  getGeneration(threadId: string, generation: number): ContinuityGeneration | null;
  latestGeneration(threadId: string): ContinuityGeneration | null;
  setGenerationState(input: {
    threadId: string;
    generation: number;
    state: GenerationState;
    nowMs: number;
  }): ContinuityGeneration | null;
  close(): void;
}

interface ItemRow {
  thread_id: string;
  launch_id: string;
  generation: number;
  family: string;
  label: string;
  state: string;
  carry_mode: string;
  operations_json: string;
  task_id: string | null;
  tool_use_id: string | null;
  scheduled_for_ms: number | null;
  terminal_outcome: string | null;
  terminal_evidence: string | null;
  terminal_observed_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface GenerationRow {
  thread_id: string;
  generation: number;
  old_session_id: string;
  launch_ids_json: string;
  state: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function defaultDeps(): Required<ContinuityStoreDeps> {
  return {
    openDbFn: (path: string) => new DatabaseSync(path),
    mkdirFn: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
  };
}

function initSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${CONTINUITY_BUSY_TIMEOUT_MS}`);
  const modeRow = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
  if (String(modeRow?.journal_mode ?? "").toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_continuity_items (
      thread_id TEXT NOT NULL,
      launch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      family TEXT NOT NULL,
      label TEXT NOT NULL,
      state TEXT NOT NULL,
      carry_mode TEXT NOT NULL,
      operations_json TEXT NOT NULL,
      task_id TEXT,
      tool_use_id TEXT,
      scheduled_for_ms INTEGER,
      terminal_outcome TEXT,
      terminal_evidence TEXT,
      terminal_observed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, launch_id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cc_continuity_items_thread_state
      ON cc_continuity_items(thread_id, state, created_at_ms)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_continuity_generations (
      thread_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      old_session_id TEXT NOT NULL,
      launch_ids_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, generation)
    )
  `);
}

function isState(value: string): value is ContinuityState {
  return value === "active" || value === "terminal" || value === "unknown";
}

function isCarryMode(value: string): value is CarryMode {
  return value === "adopt" || value === "reconstruct" || value === "rearm" || value === "unqualified";
}

function isGenerationState(value: string): value is GenerationState {
  return value === "open" || value === "closed" || value === "superseded";
}

function malformed(what: string, row: { thread_id: string; launch_id?: string; generation?: number }): Error {
  return new Error(
    `cc-lhc continuity: ${what} malformed for thread ${row.thread_id} ${row.launch_id ?? `generation ${row.generation}`}`,
  );
}

function parseOperations(json: string, row: ItemRow): ContinuityOperation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw malformed("operations", row);
  }
  if (!Array.isArray(parsed) || !parsed.every((op) => (OPERATIONS as readonly unknown[]).includes(op))) {
    throw malformed("operations", row);
  }
  return parsed as ContinuityOperation[];
}

function parseItem(row: ItemRow): ContinuityItem {
  if (!isState(row.state) || !isCarryMode(row.carry_mode)) throw malformed("item", row);
  let terminal: TerminalEvidence | null = null;
  if (row.state === "terminal") {
    if (
      row.terminal_outcome === null ||
      !(TERMINAL_OUTCOMES as readonly string[]).includes(row.terminal_outcome) ||
      row.terminal_evidence === null ||
      row.terminal_observed_at_ms === null
    ) {
      throw malformed("terminal evidence", row);
    }
    terminal = {
      outcome: row.terminal_outcome as TerminalOutcome,
      evidence: row.terminal_evidence,
      observedAtMs: row.terminal_observed_at_ms,
    };
  } else if (row.terminal_outcome !== null) {
    throw malformed("state", row);
  }
  return {
    threadId: row.thread_id,
    launchId: row.launch_id,
    generation: row.generation,
    family: row.family as AsyncWorkFamily,
    label: row.label,
    state: row.state,
    carryMode: row.carry_mode,
    operations: parseOperations(row.operations_json, row),
    taskId: row.task_id,
    toolUseId: row.tool_use_id,
    scheduledForMs: row.scheduled_for_ms,
    terminal,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function parseGeneration(row: GenerationRow): ContinuityGeneration {
  if (!isGenerationState(row.state)) throw malformed("generation", row);
  let launchIds: unknown;
  try {
    launchIds = JSON.parse(row.launch_ids_json);
  } catch {
    throw malformed("generation members", row);
  }
  if (!Array.isArray(launchIds) || !launchIds.every((id) => typeof id === "string")) {
    throw malformed("generation members", row);
  }
  return {
    threadId: row.thread_id,
    generation: row.generation,
    oldSessionId: row.old_session_id,
    launchIds: launchIds as string[],
    state: row.state,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * Open (or create) the continuity tables in the cc-lhc database. Additive:
 * coexists with the lineage, governor-receipt, and handoff-receipt tables in
 * the same file.
 */
export function openContinuityStore(
  dbPath: string = defaultLineageDbPath(),
  deps: ContinuityStoreDeps = {},
): ContinuityStore {
  const merged = { ...defaultDeps(), ...deps };
  merged.mkdirFn(dirname(dbPath));
  const db = merged.openDbFn(dbPath);
  initSchema(db);

  const selectItem = db.prepare("SELECT * FROM cc_continuity_items WHERE thread_id = ? AND launch_id = ?");
  const selectItems = db.prepare("SELECT * FROM cc_continuity_items WHERE thread_id = ? ORDER BY created_at_ms, rowid");
  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO cc_continuity_items (
      thread_id, launch_id, generation, family, label, state, carry_mode, operations_json,
      task_id, tool_use_id, scheduled_for_ms, terminal_outcome, terminal_evidence,
      terminal_observed_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 0, ?, ?, 'active', 'unqualified', '[]', ?, ?, ?, NULL, NULL, NULL, ?, ?)
  `);
  const touchItem = db.prepare(
    "UPDATE cc_continuity_items SET updated_at_ms = ? WHERE thread_id = ? AND launch_id = ? AND state != 'terminal'",
  );
  const terminalizeItem = db.prepare(`
    UPDATE cc_continuity_items
    SET state = 'terminal', terminal_outcome = ?, terminal_evidence = ?, terminal_observed_at_ms = ?, updated_at_ms = ?
    WHERE thread_id = ? AND launch_id = ? AND state != 'terminal'
  `);
  const verifyItem = db.prepare(
    "UPDATE cc_continuity_items SET state = ?, updated_at_ms = ? WHERE thread_id = ? AND launch_id = ? AND state != 'terminal'",
  );
  const carryItem = db.prepare(
    "UPDATE cc_continuity_items SET carry_mode = ?, operations_json = ?, updated_at_ms = ? WHERE thread_id = ? AND launch_id = ?",
  );
  const stampGeneration = db.prepare(
    "UPDATE cc_continuity_items SET generation = ?, updated_at_ms = ? WHERE thread_id = ? AND launch_id = ? AND generation < ?",
  );
  const selectGeneration = db.prepare("SELECT * FROM cc_continuity_generations WHERE thread_id = ? AND generation = ?");
  const selectLatestGeneration = db.prepare(
    "SELECT * FROM cc_continuity_generations WHERE thread_id = ? ORDER BY generation DESC LIMIT 1",
  );
  const insertGeneration = db.prepare(`
    INSERT INTO cc_continuity_generations (
      thread_id, generation, old_session_id, launch_ids_json, state, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'open', ?, ?)
  `);
  const supersedeOpen = db.prepare(
    "UPDATE cc_continuity_generations SET state = 'superseded', updated_at_ms = ? WHERE thread_id = ? AND state = 'open' AND generation < ?",
  );
  const updateGenerationState = db.prepare(
    "UPDATE cc_continuity_generations SET state = ?, updated_at_ms = ? WHERE thread_id = ? AND generation = ?",
  );

  const getItem = (threadId: string, launchId: string): ContinuityItem | null => {
    const row = selectItem.get(threadId, launchId) as ItemRow | undefined;
    return row === undefined ? null : parseItem(row);
  };
  const mustGet = (threadId: string, launchId: string): ContinuityItem => {
    const item = getItem(threadId, launchId);
    if (item === null) throw new Error(`cc-lhc continuity: item vanished ${threadId} ${launchId}`);
    return item;
  };
  const getGeneration = (threadId: string, generation: number): ContinuityGeneration | null => {
    const row = selectGeneration.get(threadId, generation) as GenerationRow | undefined;
    return row === undefined ? null : parseGeneration(row);
  };

  return {
    path: dbPath,
    recordLaunch(input) {
      const existing = getItem(input.threadId, input.launchId);
      if (existing !== null) return { item: existing, inserted: false };
      insertItem.run(
        input.threadId,
        input.launchId,
        input.family,
        input.label,
        input.taskId ?? null,
        input.toolUseId ?? null,
        input.scheduledForMs ?? null,
        input.nowMs,
        input.nowMs,
      );
      return { item: mustGet(input.threadId, input.launchId), inserted: true };
    },
    recordProgress(input) {
      if (getItem(input.threadId, input.launchId) === null) return null;
      touchItem.run(input.nowMs, input.threadId, input.launchId);
      return mustGet(input.threadId, input.launchId);
    },
    recordTerminal(input) {
      if (getItem(input.threadId, input.launchId) === null) return null;
      const result = terminalizeItem.run(
        input.outcome,
        input.evidence,
        input.nowMs,
        input.nowMs,
        input.threadId,
        input.launchId,
      );
      return { item: mustGet(input.threadId, input.launchId), applied: Number(result.changes) === 1 };
    },
    setVerified(input) {
      if (getItem(input.threadId, input.launchId) === null) return null;
      verifyItem.run(input.verified ? "active" : "unknown", input.nowMs, input.threadId, input.launchId);
      return mustGet(input.threadId, input.launchId);
    },
    setCarryMode(input) {
      if (getItem(input.threadId, input.launchId) === null) return null;
      if ((input.carryMode as CarryMode) === "unqualified") {
        throw new Error(`cc-lhc continuity: carry mode cannot be reset to unqualified (${input.launchId})`);
      }
      carryItem.run(
        input.carryMode,
        JSON.stringify([...input.operations]),
        input.nowMs,
        input.threadId,
        input.launchId,
      );
      return mustGet(input.threadId, input.launchId);
    },
    getItem,
    listItems(threadId) {
      return (selectItems.all(threadId) as unknown as ItemRow[]).map(parseItem);
    },
    allocateGeneration(input) {
      const latest = selectLatestGeneration.get(input.threadId) as GenerationRow | undefined;
      const generation = (latest?.generation ?? 0) + 1;
      const launchIds = [...new Set(input.launchIds)];
      db.exec("BEGIN IMMEDIATE");
      try {
        supersedeOpen.run(input.nowMs, input.threadId, generation);
        insertGeneration.run(
          input.threadId,
          generation,
          input.oldSessionId,
          JSON.stringify(launchIds),
          input.nowMs,
          input.nowMs,
        );
        for (const launchId of launchIds) {
          stampGeneration.run(generation, input.nowMs, input.threadId, launchId, generation);
        }
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
      const row = getGeneration(input.threadId, generation);
      if (row === null) throw new Error(`cc-lhc continuity: generation vanished ${input.threadId} ${generation}`);
      return row;
    },
    getGeneration,
    latestGeneration(threadId) {
      const row = selectLatestGeneration.get(threadId) as GenerationRow | undefined;
      return row === undefined ? null : parseGeneration(row);
    },
    setGenerationState(input) {
      if (getGeneration(input.threadId, input.generation) === null) return null;
      updateGenerationState.run(input.state, input.nowMs, input.threadId, input.generation);
      return getGeneration(input.threadId, input.generation);
    },
    close() {
      db.close();
    },
  };
}
