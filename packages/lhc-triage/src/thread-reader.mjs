import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SUMMARY_TYPES = {
  turn: ["turn", "detailed_turn_compression"],
  "turn-rendering": ["turn", "turn_rendering"],
  "chunk-detailed": ["chunk", "chunk_summary_detailed"],
  "chunk-brief": ["chunk", "chunk_summary_brief"],
};

function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params).map((row) => ({ ...row }));
}

function row(db, sql, ...params) {
  const value = db.prepare(sql).get(...params);
  return value === undefined ? null : { ...value };
}

function parseJson(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shorten(value, maxChars) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters]`;
}

function readableBlock(raw) {
  const parsed = parseJson(raw, raw);
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.content === "string") return parsed.content;
  }
  return JSON.stringify(parsed);
}

function currentDerivationCounts(db) {
  const grouped = rows(
    db,
    `SELECT subject_kind AS subjectKind, derivation_type AS derivationType,
            state, COUNT(*) AS count
       FROM derivation
      GROUP BY subject_kind, derivation_type, state
      ORDER BY subject_kind, derivation_type, state`,
  );
  const nested = {};
  for (const item of grouped) {
    nested[item.derivationType] ??= {};
    nested[item.derivationType][item.state] = Number(item.count);
  }
  return { grouped, nested };
}

export function openThread(filePath) {
  const absolute = resolve(filePath);
  if (!existsSync(absolute)) throw new Error(`thread file not found: ${absolute}`);
  const db = new DatabaseSync(absolute, { readOnly: true });
  db.exec("PRAGMA query_only = ON;");
  return { db, filePath: absolute };
}

export function readSummary(db, filePath) {
  const integrity = row(db, "PRAGMA integrity_check")?.integrity_check ?? "unknown";
  const userVersion = Number(row(db, "PRAGMA user_version")?.user_version ?? 0);
  const event = row(db, "SELECT COUNT(*) AS count, MAX(event_order) AS maxEventOrder FROM event");
  const turns = row(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS live,
            SUM(CASE WHEN deleted_at IS NULL AND status = 'closed' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN deleted_at IS NULL AND status = 'open' THEN 1 ELSE 0 END) AS open
       FROM turns`,
  );
  const viewRow = row(
    db,
    `SELECT view_id, created_at, compact_point, covered_from, profile_name,
            config_json, arrangement_json, gaps_json, source_state_json
       FROM thread_view WHERE singleton = 1`,
  );
  const arrangement = parseJson(viewRow?.arrangement_json, []);
  const config = parseJson(viewRow?.config_json, null);
  const sourceState = parseJson(viewRow?.source_state_json, null);
  const bands = rows(
    db,
    "SELECT band, token_count AS tokenCount, LENGTH(rendered_text) AS characters FROM thread_view_band ORDER BY band",
  ).map((item) => ({ ...item, tokenCount: Number(item.tokenCount), characters: Number(item.characters) }));
  const derivations = currentDerivationCounts(db);
  const activeWork = rows(
    db,
    `SELECT work_item_id AS workItemId, owner, kind, source_ref AS sourceRef,
            status, queued_at AS queuedAt, claimed_at AS claimedAt,
            claim_expires_at AS claimExpiresAt
       FROM work_item
      WHERE status IN ('queued', 'claimed')
      ORDER BY rowid`,
  );
  const currentProblemCounts = rows(
    db,
    `SELECT state, COUNT(*) AS count FROM derivation
      WHERE state IN ('failed', 'blocked') GROUP BY state ORDER BY state`,
  );
  return {
    filePath,
    integrity,
    userVersion,
    events: { count: Number(event?.count ?? 0), maxEventOrder: Number(event?.maxEventOrder ?? 0) },
    turns: {
      total: Number(turns?.total ?? 0),
      live: Number(turns?.live ?? 0),
      closed: Number(turns?.closed ?? 0),
      open: Number(turns?.open ?? 0),
    },
    view:
      viewRow === null
        ? null
        : {
            viewId: viewRow.view_id,
            createdAt: viewRow.created_at,
            compactPoint: Number(viewRow.compact_point),
            coveredFrom: Number(viewRow.covered_from),
            profileName: viewRow.profile_name,
            config,
            arrangementEntries: arrangement.length,
            degradedEntries: arrangement.filter((entry) => entry.degraded === true).length,
            gapEntries: arrangement.filter((entry) => entry.derivationUsed === "gap").length,
            sourceStateAtViewCreation: sourceState,
          },
    bands,
    currentDerivations: derivations.grouped,
    currentProblemCounts: currentProblemCounts.map((item) => ({ state: item.state, count: Number(item.count) })),
    activeWork,
  };
}

export function readIssues(db) {
  const failedOrBlocked = rows(
    db,
    `SELECT subject_kind AS subjectKind, subject_id AS subjectId,
            derivation_type AS derivationType, state, source_version AS sourceVersion,
            reason, derived_at AS derivedAt
       FROM derivation
      WHERE state IN ('failed', 'blocked')
      ORDER BY state, subject_kind, subject_id, derivation_type`,
  );
  const activeWork = rows(
    db,
    `SELECT work_item_id AS workItemId, owner, kind, source_ref AS sourceRef,
            status, queued_at AS queuedAt, claimed_at AS claimedAt,
            claim_expires_at AS claimExpiresAt
       FROM work_item
      WHERE status IN ('queued', 'claimed')
      ORDER BY rowid`,
  );
  const missingDetailed = rows(
    db,
    `SELECT c.chunk_id AS subjectId, c.chunk_order AS subjectOrder
       FROM chunk c
       LEFT JOIN derivation d
         ON d.subject_kind = 'chunk' AND d.subject_id = c.chunk_id
        AND d.derivation_type = 'chunk_summary_detailed'
      WHERE c.status = 'closed' AND d.subject_id IS NULL
      ORDER BY c.chunk_order`,
  ).map((item) => ({ ...item, expectedDerivation: "chunk_summary_detailed" }));
  const missingBrief = rows(
    db,
    `SELECT c.chunk_id AS subjectId, c.chunk_order AS subjectOrder
       FROM chunk c
       LEFT JOIN derivation d
         ON d.subject_kind = 'chunk' AND d.subject_id = c.chunk_id
        AND d.derivation_type = 'chunk_summary_brief'
      WHERE c.status = 'closed' AND d.subject_id IS NULL
      ORDER BY c.chunk_order`,
  ).map((item) => ({ ...item, expectedDerivation: "chunk_summary_brief" }));
  const viewRow = row(db, "SELECT arrangement_json, gaps_json, source_state_json FROM thread_view WHERE singleton = 1");
  const arrangement = parseJson(viewRow?.arrangement_json, []);
  const gaps = parseJson(viewRow?.gaps_json, []);
  const degradedFallbacks = arrangement.filter((entry) => entry.degraded === true && entry.derivationUsed !== "gap");
  const emptyGaps = arrangement
    .filter((entry) => entry.derivationUsed === "gap")
    .map((entry) => ({ ...entry, reason: gaps.find((gap) => gap.subjectId === entry.subjectId)?.reason ?? null }));
  const currentCounts = currentDerivationCounts(db).nested;
  const viewCounts = parseJson(viewRow?.source_state_json, null)?.derivationCounts ?? null;
  return {
    failedOrBlocked,
    activeWork,
    missingExpected: [...missingDetailed, ...missingBrief],
    degradedFallbacks,
    emptyGaps,
    viewSnapshotComparison: {
      note: "View source-state counts were captured when the view was built; current counts come from live derivation rows.",
      atViewCreation: viewCounts,
      current: currentCounts,
      differs: JSON.stringify(viewCounts) !== JSON.stringify(currentCounts),
    },
  };
}

export function readSummaries(db, options = {}) {
  const type = options.type ?? "all";
  const state = options.state ?? null;
  const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 200);
  const offset = Math.max(Number(options.offset ?? 0), 0);
  const maxChars = Math.min(Math.max(Number(options.maxChars ?? 500), 0), 50_000);
  const selected = type === "all" ? Object.values(SUMMARY_TYPES) : [SUMMARY_TYPES[type]];
  if (selected.some((value) => value === undefined)) {
    throw new Error(`unknown summary type: ${type}`);
  }
  const clauses = selected.map(() => "(subject_kind = ? AND derivation_type = ?)").join(" OR ");
  const params = selected.flat();
  const stateClause = state === null ? "" : " AND state = ?";
  if (state !== null) params.push(state);
  params.push(limit, offset);
  return rows(
    db,
    `SELECT subject_kind AS subjectKind, subject_id AS subjectId,
            derivation_type AS derivationType, state, source_version AS sourceVersion,
            LENGTH(content) AS contentCharacters, reason, metadata, derived_at AS derivedAt,
            content
       FROM derivation
      WHERE (${clauses})${stateClause}
      ORDER BY CASE subject_kind WHEN 'turn' THEN 0 ELSE 1 END,
               CAST(SUBSTR(subject_id, 2) AS INTEGER), derivation_type
      LIMIT ? OFFSET ?`,
    ...params,
  ).map((item) => ({
    ...item,
    sourceVersion: Number(item.sourceVersion),
    contentCharacters: item.contentCharacters === null ? null : Number(item.contentCharacters),
    metadata: parseJson(item.metadata, item.metadata),
    preview: shorten(item.content, maxChars),
    content: undefined,
  }));
}

function arrangementEntries(db, subjectKind, subjectId) {
  const view = row(db, "SELECT arrangement_json, gaps_json FROM thread_view WHERE singleton = 1");
  const gaps = parseJson(view?.gaps_json, []);
  return parseJson(view?.arrangement_json, [])
    .filter((entry) => entry.subjectKind === subjectKind && entry.subjectId === subjectId)
    .map((entry) => ({ ...entry, reason: gaps.find((gap) => gap.subjectId === subjectId)?.reason ?? null }));
}

export function readTurn(db, turnId, options = {}) {
  const maxChars = Math.min(Math.max(Number(options.maxChars ?? 2_000), 0), 50_000);
  const turn = row(db, "SELECT * FROM turns WHERE turn_id = ?", turnId);
  if (turn === null) throw new Error(`turn not found: ${turnId}`);
  const messages = rows(
    db,
    `SELECT m.message_id AS messageId, m.source_event_order AS sourceEventOrder,
            m.kind, m.actor, m.harness, m.token_estimate AS tokenEstimate,
            m.deleted_at AS deletedAt, b.block_index AS blockIndex,
            b.block_type AS blockType, b.content
       FROM message m
       JOIN message_block b ON b.message_id = m.message_id
      WHERE m.turn_id = ?
      ORDER BY m.source_event_order, b.block_index`,
    turnId,
  ).map((item) => ({
    ...item,
    sourceEventOrder: Number(item.sourceEventOrder),
    tokenEstimate: Number(item.tokenEstimate),
    blockIndex: Number(item.blockIndex),
    contentCharacters: String(item.content).length,
    preview: shorten(readableBlock(item.content), maxChars),
    content: undefined,
  }));
  const derivations = rows(
    db,
    `SELECT derivation_type AS derivationType, state, source_version AS sourceVersion,
            LENGTH(content) AS contentCharacters, reason, metadata, derived_at AS derivedAt, content
       FROM derivation WHERE subject_kind = 'turn' AND subject_id = ?
      ORDER BY derivation_type`,
    turnId,
  ).map((item) => ({
    ...item,
    sourceVersion: Number(item.sourceVersion),
    contentCharacters: item.contentCharacters === null ? null : Number(item.contentCharacters),
    metadata: parseJson(item.metadata, item.metadata),
    preview: shorten(item.content, maxChars),
    content: undefined,
  }));
  const chunks = rows(
    db,
    `SELECT cm.chunk_id AS chunkId, cm.member_idx AS memberIndex,
            c.chunk_order AS chunkOrder, c.status
       FROM chunk_member cm JOIN chunk c ON c.chunk_id = cm.chunk_id
      WHERE cm.turn_id = ? ORDER BY c.chunk_order, cm.member_idx`,
    turnId,
  );
  return { turn, messages, derivations, chunks, arrangement: arrangementEntries(db, "turn", turnId) };
}

export function readChunk(db, chunkId, options = {}) {
  const maxChars = Math.min(Math.max(Number(options.maxChars ?? 2_000), 0), 50_000);
  const chunk = row(db, "SELECT * FROM chunk WHERE chunk_id = ?", chunkId);
  if (chunk === null) throw new Error(`chunk not found: ${chunkId}`);
  const members = rows(
    db,
    `SELECT cm.turn_id AS turnId, cm.member_idx AS memberIndex,
            t.turn_order AS turnOrder, t.status, t.deleted_at AS deletedAt
       FROM chunk_member cm JOIN turns t ON t.turn_id = cm.turn_id
      WHERE cm.chunk_id = ? ORDER BY cm.member_idx`,
    chunkId,
  );
  const derivations = rows(
    db,
    `SELECT derivation_type AS derivationType, state, source_version AS sourceVersion,
            LENGTH(content) AS contentCharacters, reason, metadata, derived_at AS derivedAt, content
       FROM derivation WHERE subject_kind = 'chunk' AND subject_id = ?
      ORDER BY derivation_type`,
    chunkId,
  ).map((item) => ({
    ...item,
    sourceVersion: Number(item.sourceVersion),
    contentCharacters: item.contentCharacters === null ? null : Number(item.contentCharacters),
    metadata: parseJson(item.metadata, item.metadata),
    preview: shorten(item.content, maxChars),
    content: undefined,
  }));
  return { chunk, members, derivations, arrangement: arrangementEntries(db, "chunk", chunkId) };
}
