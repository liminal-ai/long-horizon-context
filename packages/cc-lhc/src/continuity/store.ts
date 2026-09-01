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
import type { AsyncWorkContinuation, AsyncWorkFamily } from "../observation/async-work.js";

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

/**
 * The identity a family adapter verified immediately before qualifying the
 * item — the fact the replacement will reconnect through. Platform-qualified:
 * a POSIX output identity is dev+inode; no Windows output identity is proved,
 * so none is ever recorded there.
 */
export type VerifiedIdentity =
  | { kind: "posix_output"; path: string; dev: string; ino: string }
  /** Win32 file-object identity from the opened file (volume serial + 128-bit file id, or 64-bit index), never Node dev/ino. */
  | { kind: "win32_output"; path: string; volumeId: string; fileId: string }
  | { kind: "agent_transcript"; agentId: string; path: string }
  | { kind: "workflow_run"; runId: string; scriptPath: string; journalPath: string }
  | { kind: "scheduled_time"; toolUseId: string; scheduledForMs: number }
  /** The Monitor launch record resolvable from the old session's rollout by its tool-use id; never the command text. */
  | { kind: "monitor_launch"; toolUseId: string; rolloutPath: string };

/**
 * The supported normal-path action that continues an item after the swap,
 * with the verified facts it takes. Each kind is a mechanism Story 0 proved
 * on Claude Code 2.1.252 or an accepted parent-owned operation. It is derived
 * uniquely from the verified identity, so a durable item needs no second
 * copy of the parameters.
 */
export type ContinuationMechanism =
  /** The surviving process keeps writing; the parent reads the verified output file (operation `output`). */
  | { kind: "parent_output_read"; path: string }
  /** `SendMessage(agentId)` resumes the saved transcript. */
  | { kind: "send_message"; agentId: string }
  /** `Workflow({resumeFromRunId, scriptPath})` resumes the run; completed `agent()` calls are cached. */
  | { kind: "workflow_resume"; resumeFromRunId: string; scriptPath: string }
  /** The due time is re-armed from the durable launch and surfaced at the next real turn. */
  | { kind: "rearm_at"; scheduledForMs: number }
  /**
   * The exact Monitor launch is resolved from the rollout at invocation time and
   * relaunched once for the handoff generation (`relaunchKey`), reported as `restarted`.
   */
  | { kind: "monitor_relaunch"; toolUseId: string; rolloutPath: string };

/**
 * How the replacement receives the item, truthfully: `adopted` (uninterrupted,
 * the work never stopped), `resumed` (continued from its saved record),
 * `rearmed` (re-armed from its durable time), `restarted` (relaunched; the
 * original run was interrupted).
 */
export type ContinuityTransition = "adopted" | "resumed" | "rearmed" | "restarted";

export function transitionOf(mechanism: ContinuationMechanism): ContinuityTransition {
  switch (mechanism.kind) {
    case "parent_output_read":
      return "adopted";
    case "send_message":
    case "workflow_resume":
      return "resumed";
    case "rearm_at":
      return "rearmed";
    case "monitor_relaunch":
      return "restarted";
  }
}

/** The exactly-once fence for a relaunch: one per carried item per handoff generation. */
export function relaunchKey(launchId: string, generation: number): string {
  return `${launchId}#${generation}`;
}

/** The one mechanism a verified identity supports. */
export function continuationMechanismOf(identity: VerifiedIdentity): ContinuationMechanism {
  switch (identity.kind) {
    case "posix_output":
    case "win32_output":
      return { kind: "parent_output_read", path: identity.path };
    case "agent_transcript":
      return { kind: "send_message", agentId: identity.agentId };
    case "workflow_run":
      return { kind: "workflow_resume", resumeFromRunId: identity.runId, scriptPath: identity.scriptPath };
    case "scheduled_time":
      return { kind: "rearm_at", scheduledForMs: identity.scheduledForMs };
    case "monitor_launch":
      return { kind: "monitor_relaunch", toolUseId: identity.toolUseId, rolloutPath: identity.rolloutPath };
  }
}

export interface TerminalEvidence {
  outcome: TerminalOutcome;
  /** What the record said, e.g. `task-notification completed`, `TaskStop`. */
  evidence: string;
  observedAtMs: number;
}

/**
 * The one run the parent itself started for a carried Monitor (LIM-145
 * relaunch): the parent-owned output file with its verified identity, and the
 * exact OS identity of the relaunched process when it could be read at spawn.
 * Written once per item; `stop` exists only when `process` is present.
 */
export interface RelaunchRecord {
  outputPath: string;
  output: VerifiedIdentity;
  process: { pid: number; bootId: string; starttime: string } | null;
}

/**
 * One durable terminal result for a carried item (LIM-146 AC-2.7). Written
 * exactly once, by the same write that closes the item, keyed by the item's
 * stable identity (thread + launch id); a repeated terminal observation is
 * absorbed by the item and writes nothing. Holds only the sanitized label,
 * the outcome, bounded evidence text, and the owned artifact reference —
 * never a command, task output, or provider payload.
 */
export interface CarriedResult {
  threadId: string;
  launchId: string;
  generation: number;
  family: AsyncWorkFamily;
  label: string;
  outcome: TerminalOutcome;
  evidence: string;
  artifact: { kind: "adopted_output" | "relaunch_output"; path: string } | null;
  observedAtMs: number;
  /** Delivery to the replacement is a later pass; this pass only ever writes `pending`. */
  delivery: "pending" | "delivered";
  createdAtMs: number;
}

/** Bound on stored result evidence: plain printable ASCII, one line. */
export const MAX_RESULT_EVIDENCE_CHARS = 160;

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
  /** Host continuation facts the record supplied; fields are learned once and never rewritten. */
  continuation: AsyncWorkContinuation | null;
  /** Identity verified by the qualifying adapter; null while unqualified. */
  verifiedIdentity: VerifiedIdentity | null;
  relaunch: RelaunchRecord | null;
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
  continuation?: AsyncWorkContinuation;
  nowMs: number;
}

export interface ContinuityStore {
  readonly path: string;
  /** Open one item per launch identity. An existing row (any state) is returned unchanged. */
  recordLaunch(input: RecordLaunchInput): { item: ContinuityItem; inserted: boolean };
  /**
   * Progress refreshes an open item and closes nothing. Continuation facts the
   * launch did not carry are learned here; a fact already recorded is kept.
   */
  recordProgress(input: {
    threadId: string;
    launchId: string;
    continuation?: AsyncWorkContinuation;
    nowMs: number;
  }): ContinuityItem | null;
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
  /**
   * A qualified adapter declares how it carries the item, what it can do to it,
   * and the identity it verified. Never back to `unqualified`. A terminal item
   * is left as it is.
   */
  setCarryMode(input: {
    threadId: string;
    launchId: string;
    carryMode: QualifiedCarryMode;
    operations: readonly ContinuityOperation[];
    verifiedIdentity: VerifiedIdentity;
    nowMs: number;
  }): ContinuityItem | null;
  /**
   * Record the parent's one relaunch of a carried item (learn-once; a second
   * call for the same item changes nothing) and declare the operations it
   * supports: `output` always, `stop` only with an exact process identity.
   */
  setRelaunched(input: {
    threadId: string;
    launchId: string;
    relaunch: RelaunchRecord;
    nowMs: number;
  }): ContinuityItem | null;
  getItem(threadId: string, launchId: string): ContinuityItem | null;
  /** The durable terminal result of one carried item, if it has one. */
  getResult(threadId: string, launchId: string): CarriedResult | null;
  /** Undelivered terminal results of carried items, oldest first. Reading changes nothing. */
  listPendingResults(threadId: string): CarriedResult[];
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
  continuation_json: string | null;
  identity_json: string | null;
  relaunch_json: string | null;
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
  // Additive, idempotent migrations for rows written by the foundation schema.
  for (const column of ["continuation_json", "identity_json", "relaunch_json"]) {
    if (!tableHasColumn(db, "cc_continuity_items", column)) {
      db.exec(`ALTER TABLE cc_continuity_items ADD COLUMN ${column} TEXT`);
    }
  }
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

function initResultsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_continuity_results (
      thread_id TEXT NOT NULL,
      launch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      family TEXT NOT NULL,
      label TEXT NOT NULL,
      outcome TEXT NOT NULL,
      evidence TEXT NOT NULL,
      artifact_kind TEXT,
      artifact_path TEXT,
      observed_at_ms INTEGER NOT NULL,
      delivery TEXT NOT NULL DEFAULT 'pending',
      delivered_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, launch_id)
    )
  `);
}

interface ResultRow {
  thread_id: string;
  launch_id: string;
  generation: number;
  family: string;
  label: string;
  outcome: string;
  evidence: string;
  artifact_kind: string | null;
  artifact_path: string | null;
  observed_at_ms: number;
  delivery: string;
  delivered_at_ms: number | null;
  created_at_ms: number;
}

/** Evidence text as stored: whitespace collapsed, printable ASCII only, bounded. */
export function boundedEvidence(text: string, maxChars: number = MAX_RESULT_EVIDENCE_CHARS): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  const ascii = [...flattened].map((ch) => (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? ch : "?")).join("");
  return ascii.length <= maxChars ? ascii : `${ascii.slice(0, Math.max(0, maxChars - 1))}~`;
}

/** The one artifact a terminal item owns, for the result's reference. */
function ownedArtifactOf(item: ContinuityItem): CarriedResult["artifact"] {
  if (item.relaunch !== null) return { kind: "relaunch_output", path: item.relaunch.outputPath };
  const id = item.verifiedIdentity;
  if (id !== null && (id.kind === "posix_output" || id.kind === "win32_output")) {
    return { kind: "adopted_output", path: id.path };
  }
  return null;
}

function parseResult(row: ResultRow): CarriedResult {
  const malformedResult = () => new Error(`cc-lhc continuity: malformed result row ${row.thread_id} ${row.launch_id}`);
  if (!(TERMINAL_OUTCOMES as readonly string[]).includes(row.outcome)) throw malformedResult();
  if (row.delivery !== "pending" && row.delivery !== "delivered") throw malformedResult();
  if ((row.artifact_kind === null) !== (row.artifact_path === null)) throw malformedResult();
  if (row.artifact_kind !== null && row.artifact_kind !== "adopted_output" && row.artifact_kind !== "relaunch_output") {
    throw malformedResult();
  }
  if (!Number.isInteger(row.generation) || row.generation < 1) throw malformedResult();
  return {
    threadId: row.thread_id,
    launchId: row.launch_id,
    generation: row.generation,
    family: row.family as AsyncWorkFamily,
    label: row.label,
    outcome: row.outcome as TerminalOutcome,
    evidence: row.evidence,
    artifact:
      row.artifact_kind === null || row.artifact_path === null
        ? null
        : { kind: row.artifact_kind as "adopted_output" | "relaunch_output", path: row.artifact_path },
    observedAtMs: row.observed_at_ms,
    delivery: row.delivery,
    createdAtMs: row.created_at_ms,
  };
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

const CONTINUATION_KEYS = ["outputFile", "runId", "scriptPath", "transcriptDir"] as const;

function parseContinuation(json: string | null, row: ItemRow): AsyncWorkContinuation | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw malformed("continuation", row);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw malformed("continuation", row);
  const out: AsyncWorkContinuation = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!(CONTINUATION_KEYS as readonly string[]).includes(key) || typeof value !== "string" || value === "") {
      throw malformed("continuation", row);
    }
    out[key as (typeof CONTINUATION_KEYS)[number]] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function isVerifiedIdentity(value: unknown): value is VerifiedIdentity {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  const str = (key: string): boolean => typeof o[key] === "string" && o[key] !== "";
  switch (o.kind) {
    case "posix_output":
      return str("path") && str("dev") && str("ino");
    case "win32_output":
      return str("path") && str("volumeId") && str("fileId");
    case "agent_transcript":
      return str("agentId") && str("path");
    case "workflow_run":
      return str("runId") && str("scriptPath") && str("journalPath");
    case "scheduled_time":
      return str("toolUseId") && typeof o.scheduledForMs === "number" && Number.isFinite(o.scheduledForMs);
    case "monitor_launch":
      return str("toolUseId") && str("rolloutPath");
    default:
      return false;
  }
}

function parseVerifiedIdentity(json: string | null, row: ItemRow): VerifiedIdentity | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw malformed("verified identity", row);
  }
  if (!isVerifiedIdentity(parsed)) throw malformed("verified identity", row);
  return parsed;
}

/** Learn absent continuation fields once; recorded fields are never rewritten. */
function mergeContinuation(
  recorded: AsyncWorkContinuation | null,
  learned: AsyncWorkContinuation | undefined,
): AsyncWorkContinuation | null {
  if (learned === undefined) return recorded;
  const out: AsyncWorkContinuation = { ...(recorded ?? {}) };
  for (const key of CONTINUATION_KEYS) {
    const value = learned[key];
    if (out[key] === undefined && typeof value === "string" && value !== "") out[key] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
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

function parseRelaunch(json: string | null, row: ItemRow): RelaunchRecord | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw malformed("relaunch", row);
  }
  if (parsed === null || typeof parsed !== "object") throw malformed("relaunch", row);
  const o = parsed as Record<string, unknown>;
  if (typeof o.outputPath !== "string" || o.outputPath === "" || !isVerifiedIdentity(o.output)) {
    throw malformed("relaunch", row);
  }
  let process: RelaunchRecord["process"] = null;
  if (o.process !== null) {
    const p = o.process as Record<string, unknown> | undefined;
    if (
      p === undefined ||
      typeof p !== "object" ||
      !Number.isInteger(p.pid) ||
      (p.pid as number) <= 0 ||
      typeof p.bootId !== "string" ||
      typeof p.starttime !== "string" ||
      !/^\d{1,20}$/.test(p.starttime)
    ) {
      throw malformed("relaunch", row);
    }
    process = { pid: p.pid as number, bootId: p.bootId, starttime: p.starttime };
  }
  return { outputPath: o.outputPath, output: o.output as VerifiedIdentity, process };
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
  const verifiedIdentity = parseVerifiedIdentity(row.identity_json, row);
  const relaunch = parseRelaunch(row.relaunch_json, row);
  if (row.carry_mode === "unqualified" && verifiedIdentity !== null) throw malformed("carry mode", row);
  if (row.carry_mode !== "unqualified" && verifiedIdentity === null) throw malformed("carry mode", row);
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
    continuation: parseContinuation(row.continuation_json, row),
    verifiedIdentity,
    relaunch,
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
  initResultsSchema(db);

  const selectItem = db.prepare("SELECT * FROM cc_continuity_items WHERE thread_id = ? AND launch_id = ?");
  const selectItems = db.prepare("SELECT * FROM cc_continuity_items WHERE thread_id = ? ORDER BY created_at_ms, rowid");
  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO cc_continuity_items (
      thread_id, launch_id, generation, family, label, state, carry_mode, operations_json,
      task_id, tool_use_id, scheduled_for_ms, continuation_json, identity_json, terminal_outcome,
      terminal_evidence, terminal_observed_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 0, ?, ?, 'active', 'unqualified', '[]', ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `);
  const touchItem = db.prepare(
    "UPDATE cc_continuity_items SET continuation_json = ?, updated_at_ms = ? WHERE thread_id = ? AND launch_id = ? AND state != 'terminal'",
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
    "UPDATE cc_continuity_items SET carry_mode = ?, operations_json = ?, identity_json = ?, updated_at_ms = ? WHERE thread_id = ? AND launch_id = ? AND state != 'terminal'",
  );
  const relaunchItem = db.prepare(
    "UPDATE cc_continuity_items SET relaunch_json = ?, operations_json = ?, updated_at_ms = ? WHERE thread_id = ? AND launch_id = ? AND relaunch_json IS NULL AND state != 'terminal'",
  );
  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO cc_continuity_results (
      thread_id, launch_id, generation, family, label, outcome, evidence, artifact_kind, artifact_path,
      observed_at_ms, delivery, delivered_at_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
  `);
  const selectResult = db.prepare("SELECT * FROM cc_continuity_results WHERE thread_id = ? AND launch_id = ?");
  const selectPendingResults = db.prepare(
    "SELECT * FROM cc_continuity_results WHERE thread_id = ? AND delivery = 'pending' ORDER BY observed_at_ms, rowid",
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
        JSON.stringify(mergeContinuation(null, input.continuation)) === "null"
          ? null
          : JSON.stringify(mergeContinuation(null, input.continuation)),
        input.nowMs,
        input.nowMs,
      );
      return { item: mustGet(input.threadId, input.launchId), inserted: true };
    },
    recordProgress(input) {
      const existing = getItem(input.threadId, input.launchId);
      if (existing === null) return null;
      const merged = mergeContinuation(existing.continuation, input.continuation);
      touchItem.run(merged === null ? null : JSON.stringify(merged), input.nowMs, input.threadId, input.launchId);
      return mustGet(input.threadId, input.launchId);
    },
    recordTerminal(input) {
      if (getItem(input.threadId, input.launchId) === null) return null;
      // One transaction: the item closes and, if it was carried, its single
      // durable result lands with it. A later terminal observation changes
      // neither (the item is absorbing; the result key is the item's identity).
      db.exec("BEGIN IMMEDIATE");
      let applied: boolean;
      let item: ContinuityItem;
      try {
        const result = terminalizeItem.run(
          input.outcome,
          input.evidence,
          input.nowMs,
          input.nowMs,
          input.threadId,
          input.launchId,
        );
        applied = Number(result.changes) === 1;
        item = mustGet(input.threadId, input.launchId);
        if (applied && item.generation > 0) {
          const artifact = ownedArtifactOf(item);
          insertResult.run(
            item.threadId,
            item.launchId,
            item.generation,
            item.family,
            item.label,
            input.outcome,
            boundedEvidence(input.evidence),
            artifact?.kind ?? null,
            artifact?.path ?? null,
            input.nowMs,
            input.nowMs,
          );
        }
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
      return { item, applied };
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
      if (!isVerifiedIdentity(input.verifiedIdentity)) {
        throw new Error(`cc-lhc continuity: verified identity malformed (${input.launchId})`);
      }
      carryItem.run(
        input.carryMode,
        JSON.stringify([...input.operations]),
        JSON.stringify(input.verifiedIdentity),
        input.nowMs,
        input.threadId,
        input.launchId,
      );
      return mustGet(input.threadId, input.launchId);
    },
    setRelaunched(input) {
      const item = getItem(input.threadId, input.launchId);
      if (item === null) return null;
      if (!isVerifiedIdentity(input.relaunch.output)) {
        throw new Error(`cc-lhc continuity: relaunch output identity malformed (${input.launchId})`);
      }
      const operations: ContinuityOperation[] = [
        "status",
        "output",
        ...(input.relaunch.process === null ? [] : ["stop" as const]),
      ];
      relaunchItem.run(
        JSON.stringify(input.relaunch),
        JSON.stringify(operations),
        input.nowMs,
        input.threadId,
        input.launchId,
      );
      return mustGet(input.threadId, input.launchId);
    },
    getItem,
    getResult(threadId, launchId) {
      const row = selectResult.get(threadId, launchId) as ResultRow | undefined;
      return row === undefined ? null : parseResult(row);
    },
    listPendingResults(threadId) {
      return (selectPendingResults.all(threadId) as unknown as ResultRow[]).map(parseResult);
    },
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
