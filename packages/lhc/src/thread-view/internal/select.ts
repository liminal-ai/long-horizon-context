// Band selection: compact point, smooth/detailed/brief fills, unchunked turns,
// the coverage edge (covered_from), and
// canonical-corruption detection. Two halves, deliberately split:
//
//   - readSelectionInputs: the record/derivation reads, with the corruption check
//     in the reads, before any transaction opens. A refusal here means nothing
//     was written, so the prior view is trivially intact. Never moved inside
//     the transaction.
//   - selectArrangement: a pure function over those inputs. No DB handle, no
//     clock, no inference: same inputs, same arrangement.
//
// Tie-breakers: inclusion thresholds are <=; walks are newest-first everywhere;
// chunk coverage is decided by the chunk's newest
// member turn. Entry costs are the tokens of the rendered entry text itself,
// so the budgeted tokens are the stored tokens — no second estimate.
import type { DatabaseSync } from "node:sqlite";
import * as messagesDomain from "../../messages/index.js";
import type { Band } from "../../shared-tech/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import * as turnsDomain from "../../turns/index.js";
import {
  type CompactChunkMaterialSnapshot,
  type DerivationSnapshot,
  excerptLine,
  renderArrangementEntry,
  resolveBriefRepresentation,
  resolveDetailedRepresentation,
  resolveSmoothRepresentation,
} from "./render.js";

// Canonical source state needed to identify or read the compacted span is
// damaged: compact refuses with state_corruption. Derived-material damage never
// raises this; it degrades through the ladders instead.
export class CanonicalCorruptionError extends Error {
  readonly code: "turn_state_corrupt" | "source_damaged";
  constructor(code: "turn_state_corrupt" | "source_damaged", reason: string) {
    super(reason);
    this.code = code;
    this.name = "CanonicalCorruptionError";
  }
}

export interface SelectionMessage {
  messageId: string;
  order: number; // source_event_order
  kind: string;
  tokenEstimate: number;
  turnId: string;
  text: string; // excerpt/note line (render.excerptLine)
}

export interface SelectionTurn {
  turnId: string;
  turnOrder: number;
  status: "open" | "closed";
  openedAt: number;
  closedAt: number | null;
}

export interface SelectionChunk {
  chunkId: string;
  chunkOrder: number;
  status: "open" | "closed";
  memberTurnIds: string[]; // member order
}

export interface SelectionInputs {
  messages: SelectionMessage[]; // live only, ascending order
  turns: SelectionTurn[]; // ascending turnOrder
  chunks: SelectionChunk[]; // ascending chunkOrder
  derivations: Map<string, DerivationSnapshot>; // `${subjectId}/${derivationType}` (turn/chunk subjects)
  compactChunkMaterials?: Map<string, CompactChunkMaterialSnapshot>;
  maxEventOrder: number;
  derivationCounts: Record<string, Record<string, number>>; // derivation type → state → count
}

export interface ArrangementEntry {
  band: Band;
  subjectKind: "turn" | "chunk";
  subjectId: string;
  derivationUsed: string;
  degraded: boolean;
  gap: boolean;
  reason?: string; // gap entries
  startOrder: number; // oldest event order the entry represents (notes included)
  text: string; // rendered entry text (the band stores this verbatim)
  tokens: number;
}

export interface SelectionResult {
  compactPoint: number;
  coveredFrom: number;
  // Gradient order (brief → detailed → smooth), oldest-first within band —
  // the order the bands render and the arrangement persists.
  entries: ArrangementEntry[];
}

// ── reads (corruption check lives here, pre-transaction) ─────────

export function readSelectionInputs(db: DatabaseSync): SelectionInputs {
  // Message, turn, and chunk material comes from the owner domains, not direct
  // SQL against their tables (bad-code-log: domain-boundary leakage). The
  // owners return source-faithful structure — turns carry the deleted flag,
  // chunks carry raw membership — so thread-view keeps ownership of the
  // source-state corruption policy below. The derivation and event-aggregate
  // reads stay here as thread-view's own selection inputs.
  const structure = turnsDomain.readTurnChunkStructure(db);
  // Referential checks compare against every turn row (a tombstoned turn is
  // a legitimate reference target, not damage); the selection walk itself
  // sees live turns only.
  const turnIds = new Set(structure.turns.map((row) => row.turnId));
  const turns: SelectionTurn[] = structure.turns
    .filter((row) => !row.deleted)
    .map((row) => ({
      turnId: row.turnId,
      turnOrder: row.turnOrder,
      status: row.status,
      openedAt: row.openedAtEventOrder,
      closedAt: row.closedAtEventOrder,
    }));

  // Canonical damage the walk cannot select across: the turn-state invariant
  // (at most one open turn, open turns carry no close), and referential damage
  // between chunk/message rows and their turns.
  const openTurns = turns.filter((turn) => turn.status === "open");
  if (openTurns.length > 1) {
    throw new CanonicalCorruptionError(
      "turn_state_corrupt",
      `canonical turn state corrupt: ${openTurns.length} open turns (${openTurns
        .map((turn) => turn.turnId)
        .join(", ")}); the compacted span cannot be identified`,
    );
  }
  for (const turn of turns) {
    if (turn.status === "closed" && turn.closedAt === null) {
      throw new CanonicalCorruptionError(
        "source_damaged",
        `canonical turn state corrupt: closed turn ${turn.turnId} carries no close boundary`,
      );
    }
  }

  const messages: SelectionMessage[] = messagesDomain.readLiveMessages(db).map((record) => {
    const turnId = record.turnId;
    if (!turnIds.has(turnId)) {
      throw new CanonicalCorruptionError(
        "source_damaged",
        `canonical record corrupt: message ${record.messageId} references missing turn ${turnId}`,
      );
    }
    return {
      messageId: record.messageId,
      order: record.sourceEventOrder,
      kind: record.kind,
      tokenEstimate: record.tokenEstimate,
      turnId,
      text: excerptLine(record.kind, record.blocks),
    };
  });

  const chunks: SelectionChunk[] = structure.chunks.map((row) => {
    for (const memberTurnId of row.memberTurnIds) {
      if (!turnIds.has(memberTurnId)) {
        throw new CanonicalCorruptionError(
          "source_damaged",
          `canonical record corrupt: chunk ${row.chunkId} membership references missing turn ${memberTurnId}`,
        );
      }
    }
    return {
      chunkId: row.chunkId,
      chunkOrder: row.chunkOrder,
      status: row.status,
      memberTurnIds: row.memberTurnIds,
    };
  });

  const derivationRows = db
    .prepare(
      `SELECT subject_id, derivation_type, state, content, reason FROM derivation
       WHERE subject_kind IN ('turn', 'chunk')`,
    )
    .all() as unknown as Array<{
    subject_id: string;
    derivation_type: string;
    state: string;
    content: string | null;
    reason: string | null;
  }>;
  const derivations = new Map<string, DerivationSnapshot>();
  for (const row of derivationRows) {
    const snapshot: DerivationSnapshot = { state: row.state as DerivationSnapshot["state"] };
    if (row.content !== null) snapshot.content = row.content;
    if (row.reason !== null) snapshot.reason = row.reason;
    derivations.set(`${row.subject_id}/${row.derivation_type}`, snapshot);
  }

  const maxRow = db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as {
    m: number | bigint;
  };
  const countRows = db
    .prepare(`SELECT derivation_type, state, COUNT(*) AS n FROM derivation GROUP BY derivation_type, state`)
    .all() as unknown as Array<{ derivation_type: string; state: string; n: number | bigint }>;
  const derivationCounts: Record<string, Record<string, number>> = {};
  for (const row of countRows) {
    derivationCounts[row.derivation_type] = {
      ...derivationCounts[row.derivation_type],
      [row.state]: Number(row.n),
    };
  }

  return { messages, turns, chunks, derivations, maxEventOrder: Number(maxRow.m), derivationCounts };
}

// ── the pure walk ─────────────────────────────────────────────────

export interface SelectionConfig {
  lowerBound: number;
  percentages: { full: number; smooth: number; detailed: number; brief: number };
}

export function selectArrangement(inputs: SelectionInputs, config: SelectionConfig): SelectionResult {
  const { messages, turns, chunks, derivations } = inputs;
  const lookup = (subjectId: string, derivationType: string): DerivationSnapshot | undefined =>
    derivations.get(`${subjectId}/${derivationType}`);
  const chunkMaterial = (
    chunkId: string,
    derivationType: "chunk_summary_detailed" | "chunk_summary_brief",
  ): CompactChunkMaterialSnapshot | undefined => inputs.compactChunkMaterials?.get(`${chunkId}/${derivationType}`);
  const budget = (share: number): number => (config.lowerBound * share) / 100;

  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
  const messagesByTurn = new Map<string, SelectionMessage[]>();
  for (const message of messages) {
    const list = messagesByTurn.get(message.turnId) ?? [];
    list.push(message);
    messagesByTurn.set(message.turnId, list);
  }

  // The oldest event order a turn's entry represents: its oldest live
  // message, falling back to its open boundary.
  function turnStartOrder(turn: SelectionTurn): number {
    const candidates = (messagesByTurn.get(turn.turnId) ?? []).map((message) => message.order);
    return candidates.length === 0 ? turn.openedAt : Math.min(...candidates);
  }

  // Rule 1 — compact point: messages newest-first until the estimate sum
  // first reaches the full share; the point snaps to a turn boundary so the
  // tail never begins mid-turn. Open-turn messages always land in the tail.
  const fullBudget = budget(config.percentages.full);
  const closedTurns = turns.filter((turn) => turn.status === "closed");
  let compactPoint = 0;
  if (closedTurns.length > 0 && messages.length > 0) {
    let sum = 0;
    let crossing: SelectionMessage | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as SelectionMessage;
      sum += message.tokenEstimate;
      if (sum >= fullBudget) {
        crossing = message;
        break;
      }
    }
    // Budget never reached ⇒ the whole record fits the full share:
    // everything is tail, no bands.
    compactPoint = crossing === null ? 0 : snapCompactPoint(crossing);
  }

  function snapCompactPoint(oldestTaken: SelectionMessage): number {
    const candidate = turnsById.get(oldestTaken.turnId);
    const previousClose = (turn: SelectionTurn): number => {
      const previous = closedTurns.filter((t) => t.turnOrder < turn.turnOrder).at(-1);
      return previous?.closedAt ?? 0;
    };
    if (candidate === undefined) {
      throw new CanonicalCorruptionError(
        "source_damaged",
        `canonical record corrupt: message ${oldestTaken.messageId} references missing turn ${oldestTaken.turnId}`,
      );
    }
    if (candidate.status === "open") {
      // Open-turn messages are tail regardless of budget; the tail begins at
      // the open turn's start.
      return previousClose(candidate);
    }
    // Fully covered down to the turn's start ⇒ the tail begins at this turn;
    // otherwise snap FORWARD to the next turn start — the partially-covered
    // turn falls whole to the bands.
    if (oldestTaken.order <= turnStartOrder(candidate)) {
      return previousClose(candidate);
    }
    return candidate.closedAt ?? 0;
  }

  // Band candidates: closed turns wholly behind the compact point. Rule 5 is
  // structural here — chunked or not, a banded turn is a smooth candidate
  // (bands are defined by representation, not strict time strata).
  const bandedTurns = closedTurns.filter((turn) => turn.closedAt !== null && turn.closedAt <= compactPoint);
  const bandedTurnIds = new Set(bandedTurns.map((turn) => turn.turnId));

  function buildTurnEntry(turn: SelectionTurn): ArrangementEntry {
    const turnMessages = messagesByTurn.get(turn.turnId) ?? [];
    const excerpt = turnMessages.length === 0 ? null : turnMessages.map((message) => message.text).join("\n");
    const rep = resolveSmoothRepresentation(turn.turnId, lookup, excerpt);
    const text = renderArrangementEntry("turn", turn.turnId, rep, []);
    const entry: ArrangementEntry = {
      band: "smooth",
      subjectKind: "turn",
      subjectId: turn.turnId,
      derivationUsed: rep.derivationUsed,
      degraded: rep.degraded,
      gap: rep.gap,
      startOrder: turnStartOrder(turn),
      text,
      tokens: estimateTokens(text),
    };
    if (rep.reason !== undefined) entry.reason = rep.reason;
    return entry;
  }

  function buildChunkEntry(chunk: SelectionChunk, band: "detailed" | "brief"): ArrangementEntry {
    const rep =
      band === "detailed"
        ? resolveDetailedRepresentation(chunk.chunkId, lookup, chunkMaterial(chunk.chunkId, "chunk_summary_detailed"))
        : resolveBriefRepresentation(chunk.chunkId, lookup, chunkMaterial(chunk.chunkId, "chunk_summary_brief"));
    const text = renderArrangementEntry("chunk", chunk.chunkId, rep, []);
    const memberStarts = chunk.memberTurnIds
      .map((turnId) => turnsById.get(turnId))
      .filter((turn): turn is SelectionTurn => turn !== undefined)
      .map((turn) => turnStartOrder(turn));
    const entry: ArrangementEntry = {
      band,
      subjectKind: "chunk",
      subjectId: chunk.chunkId,
      derivationUsed: rep.derivationUsed,
      degraded: rep.degraded,
      gap: rep.gap,
      startOrder: memberStarts.length === 0 ? compactPoint : Math.min(...memberStarts),
      text,
      tokens: estimateTokens(text),
    };
    if (rep.reason !== undefined) entry.reason = rep.reason;
    return entry;
  }

  // The one fill rule, shared by all three bands: newest-first whole-entry
  // fill, <= inclusion (an entry exactly filling the budget is included), the
  // first crossing entry stops the band, included only when the band was still
  // empty.
  function fillBand<T>(
    candidates: readonly T[], // newest-first
    bandBudget: number,
    build: (candidate: T) => ArrangementEntry,
  ): { included: ArrangementEntry[]; rest: T[] } {
    const included: ArrangementEntry[] = [];
    let sum = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const entry = build(candidates[i] as T);
      if (sum + entry.tokens <= bandBudget) {
        included.push(entry);
        sum += entry.tokens;
        continue;
      }
      if (included.length === 0) {
        included.push(entry);
        return { included, rest: candidates.slice(i + 1) as T[] };
      }
      return { included, rest: candidates.slice(i) as T[] };
    }
    return { included, rest: [] };
  }

  // Rule 2 + 5 — smooth band: banded closed turns newest-first, chunked or
  // not (rule 5 is structural: a closed-but-unchunked turn is a turn, takes
  // the smooth representation, and consumes this budget).
  const smooth = fillBand([...bandedTurns].reverse(), budget(config.percentages.smooth), buildTurnEntry);
  const oldestSmoothOrder = smooth.included.reduce(
    (oldest, entry) => Math.min(oldest, turnsById.get(entry.subjectId)?.turnOrder ?? Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  );

  // Rules 3–4 — chunk candidacy: chunks entirely older than the smooth
  // band's coverage, with the pinned tie-breaker doing the deciding — chunk
  // coverage is its NEWEST member turn, which must sit behind the compact
  // point and be older than the smooth band's oldest included turn.
  const chunkCandidates = chunks
    .filter((chunk) => chunk.status === "closed")
    .filter((chunk) => {
      const liveMembers = chunk.memberTurnIds
        .map((turnId) => turnsById.get(turnId))
        .filter((turn): turn is SelectionTurn => turn !== undefined);
      if (liveMembers.length === 0) return false; // fully tombstoned membership
      const newestMember = liveMembers.reduce((newest, turn) => (turn.turnOrder > newest.turnOrder ? turn : newest));
      return bandedTurnIds.has(newestMember.turnId) && newestMember.turnOrder < oldestSmoothOrder;
    })
    .reverse(); // newest-first

  // Rule 3 — detailed: same fill rule against its share.
  const detailed = fillBand(chunkCandidates, budget(config.percentages.detailed), (chunk) =>
    buildChunkEntry(chunk, "detailed"),
  );
  // Rule 4 — brief: the remaining chunks, same fill rule against its share.
  // Chunks remaining after the budget are the coverage edge — outside the
  // view, reported via covered_from, never phantom gap entries.
  const brief = fillBand(detailed.rest, budget(config.percentages.brief), (chunk) => buildChunkEntry(chunk, "brief"));

  const byRecordOrder = (a: ArrangementEntry, b: ArrangementEntry): number => a.startOrder - b.startOrder;
  const entries: ArrangementEntry[] = [
    ...brief.included.sort(byRecordOrder),
    ...detailed.included.sort(byRecordOrder),
    ...smooth.included.sort(byRecordOrder),
  ];

  const coveredFrom = entries.length === 0 ? compactPoint : Math.min(...entries.map((entry) => entry.startOrder));

  return { compactPoint, coveredFrom, entries };
}
