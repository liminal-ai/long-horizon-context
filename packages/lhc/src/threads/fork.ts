import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { health } from "../inspect/index.js";
import { messageEvents } from "../intake-stream/index.js";
import {
  CURRENT_THREAD_SCHEMA_VERSION,
  createDbReadTransaction,
  type ErrorCode,
  type ErrorResult,
  type OpResult,
  resolveInstanceDrain,
  storageFailure,
  type ViewCompactParams,
} from "../shared-tech/index.js";
import { deriveBriefChunk, deriveDetailedChunk, deriveTurn } from "../turns/index.js";
import { registerCurrentAlias, resolve, resolveThreadRef, type ThreadRef } from "./index.js";
import { deleteThreadFile, generateThreadId, openThreadDatabase } from "./internal/create.js";
import {
  insertThreadRow,
  openRegistryForWrite,
  type RegistryRow,
  resolveRegistryPath,
  selectThreadRow,
} from "./internal/registry.js";

function callerError(code: ErrorCode, reason: string): { ok: false; error: ErrorResult } {
  return { ok: false, error: { errorClass: "caller_error", code, reason } };
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface CopyThreadInput {
  source: ThreadRef;
  filePath: string;
  registryPath?: string;
  newThreadId?: string;
  keepThreadId?: boolean;
  requireIdle?: boolean;
  title?: string;
  cwd?: string;
}

export interface CopyThreadReceipt {
  threadId: string;
  sourceThreadId: string;
  filePath: string;
  rekeyed: boolean;
  schema: { source: number; copy: number };
}

interface SourceHeader {
  threadId: string;
  createdAt: string;
  schema: number;
}

function readSourceHeader(db: DatabaseSync): SourceHeader {
  const row = db.prepare("SELECT thread_id, created_at FROM thread_metadata WHERE id = 1").get() as
    | { thread_id: string; created_at: string }
    | undefined;
  if (row === undefined) throw new Error("source has no thread metadata row");
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return { threadId: row.thread_id, createdAt: row.created_at, schema: version.user_version };
}

function openTurnMemberCount(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM message m JOIN turns t ON t.turn_id = m.turn_id
       WHERE t.status = 'open' AND m.kind <> 'runtime_note' AND m.deleted_at IS NULL`,
    )
    .get() as { n: number };
  return row.n;
}

export async function copyThread(input: CopyThreadInput): Promise<OpResult<CopyThreadReceipt>> {
  if (input.filePath.trim() === "") {
    return callerError("invalid_thread_ref", "filePath must be a non-empty path; received a blank string");
  }
  if (input.newThreadId !== undefined && input.keepThreadId === true) {
    return callerError("invalid_thread_ref", "newThreadId and keepThreadId are exclusive");
  }
  if (input.newThreadId !== undefined && input.newThreadId.trim() === "") {
    return callerError("invalid_thread_ref", "newThreadId must be a non-empty id");
  }
  const source = await resolveThreadRef(input.source);
  if (!source.ok) return source;
  const sourcePath = source.value.filePath;
  let title = input.title;
  let cwd = input.cwd;
  if ("threadId" in input.source && (title === undefined || cwd === undefined)) {
    const sourceRow = await resolve(input.source);
    if (!sourceRow.ok) return sourceRow;
    title ??= sourceRow.value.title;
    cwd ??= sourceRow.value.cwd;
  }
  if (!existsSync(sourcePath)) {
    return callerError("thread_not_found", `no thread file at ${sourcePath}`);
  }
  if (resolvePath(sourcePath) === resolvePath(input.filePath)) {
    return callerError("invalid_thread_ref", "source and filePath must name different files");
  }
  if (existsSync(input.filePath)) {
    return callerError("path_exists", `a file already exists at ${input.filePath}`);
  }

  let sourceDb: DatabaseSync | undefined;
  let header: SourceHeader;
  try {
    mkdirSync(dirname(input.filePath), { recursive: true });
    sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
    header = readSourceHeader(sourceDb);
    await backup(sourceDb, input.filePath);
  } catch (cause) {
    deleteThreadFile(input.filePath);
    return storageFailure(`thread backup failed: ${detail(cause)}`);
  } finally {
    sourceDb?.close();
  }

  const threadId = input.keepThreadId === true ? header.threadId : (input.newThreadId ?? generateThreadId());
  const rekeyed = threadId !== header.threadId;

  const opened = openThreadDatabase(input.filePath);
  if (!opened.ok) {
    deleteThreadFile(input.filePath);
    return opened;
  }
  const copyDb = opened.value;
  let copySchema: number;
  try {
    const copied = readSourceHeader(copyDb);
    if (copied.threadId !== header.threadId) {
      throw new Error(`identity mismatch: expected ${header.threadId}, got ${copied.threadId}`);
    }
    copySchema = copied.schema;
    if (input.requireIdle !== false) {
      const members = openTurnMemberCount(copyDb);
      if (members > 0) {
        copyDb.close();
        deleteThreadFile(input.filePath);
        return callerError(
          "mid_turn",
          `source ${header.threadId} is mid-turn: its open turn holds ${members} member(s); retry when the turn has ended`,
        );
      }
    }
    if (rekeyed) {
      copyDb.prepare("UPDATE thread_metadata SET thread_id = ? WHERE id = 1").run(threadId);
    }
  } catch (cause) {
    copyDb.close();
    deleteThreadFile(input.filePath);
    return storageFailure(`thread copy verification failed: ${detail(cause)}`);
  }
  copyDb.close();

  let registry: DatabaseSync | undefined;
  try {
    registry = openRegistryForWrite(resolveRegistryPath(input.registryPath));
    if (selectThreadRow(registry, threadId) !== undefined) {
      deleteThreadFile(input.filePath);
      return callerError("thread_exists", `thread ${threadId} is already registered`);
    }
    const row: RegistryRow = {
      threadId,
      filePath: input.filePath,
      createdAt: rekeyed ? new Date().toISOString() : header.createdAt,
    };
    if (title !== undefined) row.title = title;
    if (cwd !== undefined) row.cwd = cwd;
    insertThreadRow(registry, row);
  } catch (cause) {
    deleteThreadFile(input.filePath);
    return storageFailure(`copied thread registry insert failed: ${detail(cause)}`);
  } finally {
    registry?.close();
  }

  return {
    ok: true,
    value: {
      threadId,
      sourceThreadId: header.threadId,
      filePath: input.filePath,
      rekeyed,
      schema: { source: header.schema, copy: copySchema },
    },
  };
}

export type ForkHost = "cc-lhc" | "claude-lhc" | "codex-lhc" | "grok" | "hermes";
export const FORK_HOSTS: readonly ForkHost[] = ["cc-lhc", "claude-lhc", "codex-lhc", "grok", "hermes"];

export const SOURCE_ONLY_HOSTS: readonly ForkHost[] = ["hermes"];
export function isSourceOnlyHost(host: ForkHost): boolean {
  return SOURCE_ONLY_HOSTS.includes(host);
}

export type HostBinding = { kind: "alias"; alias: string } | { kind: "file"; fileName: string };

export const RUST_HOST_THREAD_SCHEMA_VERSION = 13;
export const FILE_HOST_THREAD_SCHEMA_VERSION: number = CURRENT_THREAD_SCHEMA_VERSION;

export const HOST_PROVIDERS: Readonly<Record<ForkHost, string>> = {
  "cc-lhc": "anthropic",
  "claude-lhc": "anthropic",
  "codex-lhc": "openai",
  grok: "xai",
  hermes: "hermes",
};

export function hostProvider(host: ForkHost): string {
  return HOST_PROVIDERS[host];
}

export type ForkCompactChoice = "auto" | "always" | "never";
export interface ForkCompactPlan {
  compact: boolean;
  reason: string;
}

export function forkCompactPlan(
  sourceHost: ForkHost,
  host: ForkHost,
  choice: ForkCompactChoice = "auto",
): ForkCompactPlan {
  if (choice === "always") return { compact: true, reason: "forced" };
  if (choice === "never") return { compact: false, reason: "suppressed" };
  const from = hostProvider(sourceHost);
  const to = hostProvider(host);
  return from === to
    ? { compact: false, reason: `same provider ${to}` }
    : { compact: true, reason: `${from} -> ${to}` };
}

export const HANDOFF_PROFILE = "handoff";

export function handoffCompactOptions(lowerBound?: number): { profile: string; params?: ViewCompactParams } {
  return lowerBound === undefined ? { profile: HANDOFF_PROFILE } : { profile: HANDOFF_PROFILE, params: { lowerBound } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function forkThreadId(host: ForkHost, given: { newId?: string; sessionId?: string }): OpResult<string> {
  switch (host) {
    case "codex-lhc": {
      if (given.newId !== undefined && given.sessionId !== undefined && given.newId !== given.sessionId) {
        return callerError(
          "invalid_thread_alias",
          `host codex-lhc keys the record by its rollout uuid: --new-id ${given.newId} and --session-id ${given.sessionId} must agree`,
        );
      }
      const id = given.newId ?? given.sessionId ?? randomUUID();
      if (!UUID_RE.test(id))
        return callerError("invalid_thread_alias", `host codex-lhc needs a uuid thread id, got ${id}`);
      return { ok: true, value: id };
    }
    case "grok":
      return { ok: true, value: given.newId ?? randomUUID() };
    default:
      return { ok: true, value: given.newId ?? generateThreadId() };
  }
}

function encodeForPath(id: string, unsafe: RegExp): string {
  return id.replace(unsafe, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
const CODEX_UNSAFE = /[^A-Za-z0-9-]/g;
const GROK_UNSAFE = /[^A-Za-z0-9_-]/g;
const HERMES_SAFE = /^[A-Za-z0-9_-]+$/;

export function hostBinding(host: ForkHost, sessionId?: string): OpResult<HostBinding> {
  if (sessionId === undefined || sessionId.trim() === "") {
    return callerError("invalid_thread_alias", `host ${host} binds by session id; none given`);
  }
  switch (host) {
    case "cc-lhc":
      return { ok: true, value: { kind: "alias", alias: `claude-code:${sessionId}` } };
    case "claude-lhc":
      return { ok: true, value: { kind: "alias", alias: `t3code-lhc:${sessionId}` } };
    case "codex-lhc":
      return { ok: true, value: { kind: "file", fileName: `${encodeForPath(sessionId, CODEX_UNSAFE)}.sqlite` } };
    case "grok":
      return {
        ok: true,
        value: { kind: "file", fileName: `grok-${encodeForPath(sessionId, GROK_UNSAFE)}.sqlite` },
      };
    case "hermes": {
      if (!HERMES_SAFE.test(sessionId)) {
        return callerError(
          "invalid_thread_alias",
          `host hermes names the file after the session verbatim; ${sessionId} is not path-safe`,
        );
      }
      return { ok: true, value: { kind: "file", fileName: `${sessionId}.sqlite` } };
    }
    default:
      return callerError("invalid_thread_alias", `unknown host ${String(host)}; one of ${FORK_HOSTS.join(", ")}`);
  }
}

export interface BindHostInput {
  threadId: string;
  registryPath?: string;
  host: ForkHost;
  sessionId?: string;
}

export async function bindHost(input: BindHostInput): Promise<OpResult<HostBinding>> {
  const binding = hostBinding(input.host, input.sessionId);
  if (!binding.ok) return binding;
  switch (binding.value.kind) {
    case "alias": {
      const registration: { alias: string; threadId: string; registryPath?: string } = {
        alias: binding.value.alias,
        threadId: input.threadId,
      };
      if (input.registryPath !== undefined) registration.registryPath = input.registryPath;
      const bound = await registerCurrentAlias(registration);
      return bound.ok ? binding : bound;
    }
    case "file":
      return callerError(
        "file_bound_host",
        `host ${input.host} binds by file name ${binding.value.fileName}; choose it at copy time`,
      );
  }
}

export interface IdentityNoteInput {
  ref: ThreadRef;
  sourceThreadId: string;
  sourceHome?: string;
  seat?: string;
  at?: string;
}

export interface IdentityNoteReceipt {
  text: string;
  messageId: string;
}

export function identityNoteText(input: Omit<IdentityNoteInput, "ref">): string {
  const at = input.at ?? new Date().toISOString();
  const from = input.sourceHome === undefined ? input.sourceThreadId : `${input.sourceThreadId} (${input.sourceHome})`;
  const seat = input.seat === undefined ? "" : `, seat ${input.seat}`;
  return `[lhc fork] copied from ${from} on ${at}${seat}`;
}

export async function writeIdentityNote(input: IdentityNoteInput): Promise<OpResult<IdentityNoteReceipt>> {
  if (input.sourceThreadId.trim() === "") {
    return callerError("invalid_thread_ref", "sourceThreadId must be a non-empty id");
  }
  const text = identityNoteText(input);
  const at = input.at ?? new Date().toISOString();
  const recorded = await messageEvents(input.ref, [
    {
      eventKind: "runtime_note",
      idempotencyKey: `lhc-fork:${input.sourceThreadId}:${at}`,
      actor: "lhc-fork",
      harness: "lhc",
      payload: { text },
    },
  ]);
  if (!recorded.ok) return recorded;
  const first = recorded.value.events[0];
  if (first === undefined || first.outcome !== "recorded" || first.messageId === undefined) {
    return storageFailure(`identity note was not recorded (${first?.outcome ?? "no event"})`);
  }
  return { ok: true, value: { text, messageId: first.messageId } };
}

export interface HistoryBlock {
  blockType: string;
  content: Record<string, unknown>;
}

export interface HistoryMessage {
  messageId: string;
  kind: string;
  eventOrder: number;
  recordedAt: string;
  actor: string;
  harness: string;
  blocks: HistoryBlock[];
}

export interface HistoryTurn {
  turnId: string;
  order: number;
  status: "open" | "closed";
  outcome: "completed" | "aborted" | null;
  outcomeReason: string | null;
  messages: HistoryMessage[];
}

export interface HistoryExport {
  threadId: string;
  exportedAt: string;
  turns: HistoryTurn[];
  omitted: Record<string, number>;
}

export const HISTORY_EXPORT_KINDS: readonly string[] = [
  "user_prompt",
  "assistant_text",
  "tool_call",
  "tool_result",
  "runtime_note",
];

export async function exportHistory(ref: ThreadRef): Promise<OpResult<HistoryExport>> {
  try {
    const result = await createDbReadTransaction(ref, (transaction): OpResult<HistoryExport> => {
      const db = transaction.db;
      const meta = db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").get() as
        | { thread_id: string }
        | undefined;
      if (meta === undefined) return storageFailure(`thread file at ${transaction.filePath} lost its metadata row`);
      const turnRows = db
        .prepare(
          `SELECT turn_id, turn_order, status, outcome, outcome_reason FROM turns
           WHERE deleted_at IS NULL ORDER BY turn_order`,
        )
        .all() as Array<{
        turn_id: string;
        turn_order: number;
        status: "open" | "closed";
        outcome: "completed" | "aborted" | null;
        outcome_reason: string | null;
      }>;
      const messageRows = db
        .prepare(
          `SELECT m.message_id, m.kind, m.turn_id, m.source_event_order, m.actor, m.harness, e.recorded_at
           FROM message m JOIN event e ON e.event_order = m.source_event_order
           WHERE m.deleted_at IS NULL ORDER BY m.source_event_order`,
        )
        .all() as Array<{
        message_id: string;
        kind: string;
        turn_id: string;
        source_event_order: number;
        actor: string;
        harness: string;
        recorded_at: string;
      }>;
      const blockStatement = db.prepare(
        "SELECT block_type, content FROM message_block WHERE message_id = ? ORDER BY block_index",
      );
      const byTurn = new Map<string, HistoryMessage[]>();
      const omitted: Record<string, number> = {};
      for (const row of messageRows) {
        if (!HISTORY_EXPORT_KINDS.includes(row.kind)) {
          omitted[row.kind] = (omitted[row.kind] ?? 0) + 1;
          continue;
        }
        const blocks = (blockStatement.all(row.message_id) as Array<{ block_type: string; content: string }>).map(
          (block) => ({ blockType: block.block_type, content: JSON.parse(block.content) as Record<string, unknown> }),
        );
        const list = byTurn.get(row.turn_id) ?? [];
        list.push({
          messageId: row.message_id,
          kind: row.kind,
          eventOrder: row.source_event_order,
          recordedAt: row.recorded_at,
          actor: row.actor,
          harness: row.harness,
          blocks,
        });
        byTurn.set(row.turn_id, list);
      }
      const turns: HistoryTurn[] = turnRows.map((row) => ({
        turnId: row.turn_id,
        order: row.turn_order,
        status: row.status,
        outcome: row.outcome,
        outcomeReason: row.outcome_reason,
        messages: byTurn.get(row.turn_id) ?? [],
      }));
      return {
        ok: true,
        value: { threadId: meta.thread_id, exportedAt: new Date().toISOString(), turns, omitted },
      };
    });
    return result.ok ? result.value : result;
  } catch (cause) {
    return storageFailure(`history export failed: ${detail(cause)}`);
  }
}

export interface RepairInput {
  ref: ThreadRef;
  limit?: number;
  rounds?: number;
}

export interface RepairTally {
  attempted: number;
  repaired: number;
  failed: number;
  deferred: number;
}

export interface RepairReceipt {
  turns: RepairTally;
  chunks: RepairTally;
  remainingFailures: number;
  errors: Array<{ subjectKind: "turn" | "chunk"; subjectId: string; code: string; reason: string }>;
}

export const REPAIR_ERROR_CAP = 20;

const DETAILED_TURN = "detailed_turn_compression";

async function repairTargets(ref: ThreadRef): Promise<OpResult<{ turns: string[]; chunks: string[] }>> {
  const read = await createDbReadTransaction(ref, (transaction): OpResult<{ turns: string[]; chunks: string[] }> => {
    const db = transaction.db;
    const turns = (
      db
        .prepare(
          `SELECT d.subject_id AS id FROM derivation d JOIN turns t ON t.turn_id = d.subject_id
           WHERE d.subject_kind = 'turn' AND d.derivation_type = ? AND d.state = 'failed' ORDER BY t.turn_order`,
        )
        .all(DETAILED_TURN) as Array<{ id: string }>
    ).map((row) => row.id);
    const chunks = (
      db
        .prepare(
          `SELECT DISTINCT c.chunk_id AS id FROM chunk c JOIN chunk_member cm ON cm.chunk_id = c.chunk_id
             JOIN derivation d ON d.subject_kind = 'turn' AND d.subject_id = cm.turn_id
           WHERE c.status = 'closed' AND d.derivation_type = ? AND d.state = 'failed'
           UNION SELECT subject_id FROM derivation
             WHERE subject_kind = 'chunk' AND derivation_type IN ('chunk_summary_detailed', 'chunk_summary_brief')
               AND state IN ('failed', 'blocked')
           ORDER BY 1`,
        )
        .all(DETAILED_TURN) as Array<{ id: string }>
    ).map((row) => row.id);
    return { ok: true, value: { turns, chunks } };
  });
  return read.ok ? read.value : read;
}

type Verdict = "repaired" | "failed" | "deferred";

function errorOf(result: OpResult<{ outcome?: string; error?: ErrorResult }>): ErrorResult | undefined {
  if (!result.ok) return result.error;
  return result.value.error;
}

function outcomeOf(result: OpResult<{ outcome?: string; error?: ErrorResult }>): Verdict {
  if (!result.ok) return "failed";
  const outcome = result.value.outcome;
  if (outcome === "derived" || outcome === "ready") return "repaired";
  return result.value.error?.code === "derivation_work_in_flight" ? "deferred" : "failed";
}

async function repairPass(input: RepairInput): Promise<OpResult<RepairReceipt>> {
  const targets = await repairTargets(input.ref);
  if (!targets.ok) return targets;
  const limit = input.limit;
  const turnList = limit === undefined ? targets.value.turns : targets.value.turns.slice(0, limit);
  const chunkList = limit === undefined ? targets.value.chunks : targets.value.chunks.slice(0, limit);

  const errors: RepairReceipt["errors"] = [];
  const noteError = (subjectKind: "turn" | "chunk", subjectId: string, error: ErrorResult | undefined): void => {
    if (error === undefined || errors.length >= REPAIR_ERROR_CAP) return;
    errors.push({ subjectKind, subjectId, code: error.code, reason: error.reason });
  };
  const turns: RepairTally = { attempted: 0, repaired: 0, failed: 0, deferred: 0 };
  for (const turnId of turnList) {
    turns.attempted += 1;
    const result = await deriveTurn(input.ref, turnId);
    if (!result.ok && result.error.code === "inference_unavailable") return result;
    const verdict = outcomeOf(result);
    turns[verdict] += 1;
    if (verdict !== "repaired") noteError("turn", turnId, errorOf(result));
  }

  const chunks: RepairTally = { attempted: 0, repaired: 0, failed: 0, deferred: 0 };
  for (const chunkId of chunkList) {
    chunks.attempted += 1;
    const detailedResult = await deriveDetailedChunk(input.ref, chunkId);
    const briefResult = await deriveBriefChunk(input.ref, chunkId);
    const detailed = outcomeOf(detailedResult);
    const brief = outcomeOf(briefResult);
    if (detailed !== "repaired") noteError("chunk", chunkId, errorOf(detailedResult));
    else if (brief !== "repaired") noteError("chunk", chunkId, errorOf(briefResult));
    const verdict: Verdict =
      detailed === "repaired" && brief === "repaired"
        ? "repaired"
        : detailed === "deferred" || brief === "deferred"
          ? "deferred"
          : "failed";
    chunks[verdict] += 1;
  }

  const after = await health(input.ref);
  if (!after.ok) return after;
  return { ok: true, value: { turns, chunks, remainingFailures: after.value.failures.length, errors } };
}

const DEFAULT_REPAIR_ROUNDS = 3;

async function drainCarriedWork(filePath: string): Promise<OpResult<number>> {
  const drain = resolveInstanceDrain();
  if (drain === undefined) return { ok: true, value: 0 };
  let ran = 0;
  for (;;) {
    const report = await drain(filePath, { maxItems: 25 });
    if (!report.ok) return report;
    if (report.value.ran.length === 0) return { ok: true, value: ran };
    ran += report.value.ran.length;
  }
}

function sumTally(a: RepairTally, b: RepairTally): RepairTally {
  return {
    attempted: a.attempted + b.attempted,
    repaired: a.repaired + b.repaired,
    failed: a.failed + b.failed,
    deferred: b.deferred,
  };
}

export async function repairDerivations(input: RepairInput): Promise<OpResult<RepairReceipt>> {
  const resolved = await resolveThreadRef(input.ref);
  if (!resolved.ok) return resolved;
  const filePath = resolved.value.filePath;
  const rounds = Math.max(1, input.rounds ?? DEFAULT_REPAIR_ROUNDS);
  let receipt: RepairReceipt | undefined;
  for (let round = 0; round < rounds; round += 1) {
    const drained = await drainCarriedWork(filePath);
    if (!drained.ok) return drained;
    const pass = await repairPass({ ...input, ref: { filePath } });
    if (!pass.ok) return pass;
    receipt =
      receipt === undefined
        ? pass.value
        : {
            turns: sumTally(receipt.turns, pass.value.turns),
            chunks: sumTally(receipt.chunks, pass.value.chunks),
            remainingFailures: pass.value.remainingFailures,
            errors: pass.value.errors,
          };
    if (pass.value.turns.deferred + pass.value.chunks.deferred === 0) break;
  }
  const settled = await drainCarriedWork(filePath);
  if (!settled.ok) return settled;
  return { ok: true, value: receipt as RepairReceipt };
}

export function generateThreadIdForCli(): string {
  return generateThreadId();
}
