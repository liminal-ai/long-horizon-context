// Message-domain reads for derivation: a handler can read its source message
// and call-id pair, nothing more. Pair lookup is one indexed query by call id,
// never a block scan, drain-time sweep, or read-time join. Completion writes
// ride the work-queue util's version-checked `complete`; no write path lives
// here. Read-back returns stored message-owned derivation rows as stored, never
// re-derived on read.
import type { DatabaseSync } from "node:sqlite";
import type {
  DependencyGap,
  Derivation,
  DerivationMetadata,
  DerivationReportEntry,
  DerivationState,
} from "../../shared-tech/index.js";
import { type RawReportRow, reportEntryFromRow } from "../../shared-tech/index.js";

export interface MessageSource {
  messageId: string;
  kind: string;
  blocks: Array<{ blockType: string; content: Record<string, unknown> }>;
}

export function readMessageSource(db: DatabaseSync, messageId: string): MessageSource | undefined {
  const row = db.prepare(`SELECT kind FROM message WHERE message_id = ?`).get(messageId) as unknown as
    | { kind: string }
    | undefined;
  if (row === undefined) return undefined;
  const blocks = db
    .prepare(
      `SELECT block_type, content FROM message_block
       WHERE message_id = ? ORDER BY block_index`,
    )
    .all(messageId) as unknown as Array<{ block_type: string; content: string }>;
  return {
    messageId,
    kind: row.kind,
    blocks: blocks.map((block) => ({
      blockType: block.block_type,
      content: JSON.parse(block.content) as Record<string, unknown>,
    })),
  };
}

interface RawDerivationRow {
  subject_id: string;
  derivation_type: string;
  state: string;
  content: string | null;
  reason: string | null;
  metadata: string | null;
  source_version: number | bigint;
  gaps: string | null;
  derived_at: string | null;
}

// Every message-owned derivation row, grouped by message id — the derivation
// read-back joined onto message reads. Rows come back exactly as the queue
// landed them: state, content, reason, mechanically stamped metadata; nothing
// is derived at read time.
//
// messageIds, when provided, scopes the read to just those subjects so a
// bounded list loads only its window's derivations, never every message-owned
// derivation in the thread. Omitted — the report-surface path that already
// reads its own scope — reads all message-owned derivation rows as before.
export function readMessageDerivations(db: DatabaseSync, messageIds?: readonly string[]): Map<string, Derivation[]> {
  const byMessage = new Map<string, Derivation[]>();
  if (messageIds !== undefined && messageIds.length === 0) return byMessage;
  const rows: RawDerivationRow[] = [];
  const scopedMessageIds = messageIds === undefined ? undefined : [...new Set(messageIds)].sort();
  const batches: ReadonlyArray<readonly string[]> =
    scopedMessageIds === undefined
      ? [[]]
      : Array.from({ length: Math.ceil(scopedMessageIds.length / 400) }, (_, index) =>
          scopedMessageIds.slice(index * 400, (index + 1) * 400),
        );
  for (const batch of batches) {
    const idFilter = messageIds === undefined ? "" : ` AND subject_id IN (${batch.map(() => "?").join(", ")})`;
    rows.push(
      ...(db
        .prepare(
          `SELECT subject_id, derivation_type, state, content, reason, metadata,
                  source_version, gaps, derived_at
           FROM derivation WHERE subject_kind = 'message'${idFilter}
           ORDER BY subject_id, derivation_type`,
        )
        .all(...batch) as unknown as RawDerivationRow[]),
    );
  }
  for (const row of rows) {
    const record: Derivation = {
      subjectKind: "message",
      subjectId: row.subject_id,
      derivationType: row.derivation_type as string,
      state: row.state as DerivationState,
      sourceVersion: Number(row.source_version),
    };
    if (row.content !== null) record.content = row.content;
    if (row.reason !== null) record.reason = row.reason;
    if (row.metadata !== null) {
      record.metadata = JSON.parse(row.metadata) as DerivationMetadata;
    }
    if (row.gaps !== null) record.gaps = JSON.parse(row.gaps) as DependencyGap[];
    if (row.derived_at !== null) record.derivedAt = row.derived_at;
    const derivations = byMessage.get(row.subject_id) ?? [];
    derivations.push(record);
    byMessage.set(row.subject_id, derivations);
  }
  return byMessage;
}

// One derivation row by exact key — the requeue operation's refusal read (missing
// row, blocked state, current source version). State returned as stored.
export function readMessageDerivationRow(
  db: DatabaseSync,
  messageId: string,
  derivationType: string,
): { state: DerivationState; reason?: string; sourceVersion: number } | undefined {
  const row = db
    .prepare(
      `SELECT state, reason, source_version FROM derivation
       WHERE subject_kind = 'message' AND subject_id = ? AND derivation_type = ?`,
    )
    .get(messageId, derivationType) as unknown as
    | { state: string; reason: string | null; source_version: number | bigint }
    | undefined;
  if (row === undefined) return undefined;
  const view: { state: DerivationState; reason?: string; sourceVersion: number } = {
    state: row.state as DerivationState,
    sourceVersion: Number(row.source_version),
  };
  if (row.reason !== null) view.reason = row.reason;
  return view;
}

// The message owner's report is one query: message-owned derivation rows LEFT
// JOINed with the live work_item still targeting each derivation at its current
// source version, if any. Terminal outcomes already live on derivation rows. No
// N+1, no in-memory assembly beyond row mapping. The derivation_type→kind CASE
// is the owner's own queue-site mapping (MESSAGE_WORK_DERIVATIONS) inverted.
export function reportMessageDerivations(
  db: DatabaseSync,
  opts: { notReady?: boolean; messageId?: string } = {},
): DerivationReportEntry[] {
  const conditions = ["df.subject_kind = 'message'"];
  const params: string[] = [];
  if (opts.messageId !== undefined) {
    conditions.push("df.subject_id = ?");
    params.push(opts.messageId);
  }
  // notReady is exact set equality by construction: every state but ready.
  if (opts.notReady === true) conditions.push("df.state <> 'ready'");
  const rows = db
    .prepare(
      `SELECT df.subject_id, df.derivation_type, df.state, df.content, df.reason, df.metadata,
              df.source_version, df.gaps, df.derived_at,
              w.status AS queue_status
       FROM derivation df
       LEFT JOIN work_item w
         ON w.status IN ('queued', 'claimed')
        AND w.kind = CASE df.derivation_type WHEN 'smoothed_prompt' THEN 'prompt_smoothing' ELSE df.derivation_type END
        AND json_extract(w.source_ref, '$.messageId') = df.subject_id
        AND COALESCE(json_extract(w.payload, '$.sourceVersion'), 1) = df.source_version
       WHERE ${conditions.join(" AND ")}
       ORDER BY df.subject_id, df.derivation_type`,
    )
    .all(...params) as unknown as RawReportRow[];
  return rows.map((row) => reportEntryFromRow("message", row));
}

// The call-id pairing reads. Earliest-recorded block wins if a call id were
// ever repeated; in a valid record the pair is unique. Deleted messages
// are excluded: composition inputs and derivation reads never see deleted
// records, so a tool_call whose paired result has been deleted reads no pair
// and derives outcome `unknown` — never the dead result's outcome.
function findPairedBlock(
  db: DatabaseSync,
  blockType: "tool_call" | "tool_result",
  toolCallId: string,
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT b.content FROM message_block b
       JOIN message m ON m.message_id = b.message_id AND m.deleted_at IS NULL
       WHERE b.block_type = ? AND json_extract(b.content, '$.toolCallId') = ?
       ORDER BY m.source_event_order LIMIT 1`,
    )
    .get(blockType, toolCallId) as unknown as { content: string } | undefined;
  if (row === undefined) return undefined;
  return JSON.parse(row.content) as Record<string, unknown>;
}

export function findPairedToolResult(
  db: DatabaseSync,
  toolCallId: string,
): { content: string; isError: boolean } | undefined {
  const block = findPairedBlock(db, "tool_result", toolCallId);
  if (block === undefined) return undefined;
  return {
    content: typeof block["content"] === "string" ? block["content"] : "",
    isError: block["isError"] === true,
  };
}

export function findPairedToolCall(
  db: DatabaseSync,
  toolCallId: string,
): { toolName: string; toolInput?: Record<string, unknown> } | undefined {
  const block = findPairedBlock(db, "tool_call", toolCallId);
  if (block === undefined) return undefined;
  const args = block["arguments"];
  return {
    toolName: typeof block["toolName"] === "string" ? block["toolName"] : "",
    ...(args !== null && typeof args === "object" && !Array.isArray(args)
      ? { toolInput: args as Record<string, unknown> }
      : {}),
  };
}
