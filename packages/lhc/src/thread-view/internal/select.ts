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
//
// An entry too large for its band's remaining budget stops smooth and detailed
// (the rest cascades to the next band's candidates) but only skips in brief:
// brief is the last band, and one unrepresentable entry may not end the walk
// over everything older. A skipped subject renders no band text; it is
// reported as a gap (SelectionResult.skipped) and covered_from runs to the
// oldest INCLUDED entry, so coverage extends past the hole.
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
  // Derived chunks whose stored members are all legitimate tombstoned turns.
  // Preview ignores them; compact removes them with the replacement view.
  emptyChunkIds?: string[];
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

// A candidate the last band's walk passed over because it did not fit while
// older candidates still did: no band text, but a gap the receipt and
// gaps_json name — subject, band, and the size that did not fit.
export interface SkippedSubject {
  band: Band;
  subjectId: string;
  tokens: number;
  reason: string;
}

export interface SelectionResult {
  compactPoint: number;
  coveredFrom: number;
  // Gradient order (brief → detailed → smooth), oldest-first within band —
  // the order the bands render and the arrangement persists.
  entries: ArrangementEntry[];
  skipped: SkippedSubject[];
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

  const liveTurnIds = new Set(turns.map((turn) => turn.turnId));
  const emptyChunkIds: string[] = [];
  const chunks: SelectionChunk[] = structure.chunks.flatMap((row) => {
    for (const memberTurnId of row.memberTurnIds) {
      if (!turnIds.has(memberTurnId)) {
        throw new CanonicalCorruptionError(
          "source_damaged",
          `canonical record corrupt: chunk ${row.chunkId} membership references missing turn ${memberTurnId}`,
        );
      }
    }
    if (!row.memberTurnIds.some((turnId) => liveTurnIds.has(turnId))) {
      emptyChunkIds.push(row.chunkId);
      return [];
    }
    return [
      {
        chunkId: row.chunkId,
        chunkOrder: row.chunkOrder,
        status: row.status,
        memberTurnIds: row.memberTurnIds,
      },
    ];
  });

  const derivationRows = db
    .prepare(`SELECT subject_kind, subject_id, derivation_type, state, content, reason FROM derivation`)
    .all() as unknown as Array<{
    subject_kind: string;
    subject_id: string;
    derivation_type: string;
    state: string;
    content: string | null;
    reason: string | null;
  }>;
  const derivations = new Map<string, DerivationSnapshot>();
  const emptyChunkSet = new Set(emptyChunkIds);
  const derivationCounts: Record<string, Record<string, number>> = {};
  for (const row of derivationRows) {
    if (row.subject_kind === "chunk" && emptyChunkSet.has(row.subject_id)) continue;
    derivationCounts[row.derivation_type] = {
      ...derivationCounts[row.derivation_type],
      [row.state]: (derivationCounts[row.derivation_type]?.[row.state] ?? 0) + 1,
    };
    if (row.subject_kind !== "turn" && row.subject_kind !== "chunk") continue;
    const snapshot: DerivationSnapshot = { state: row.state as DerivationSnapshot["state"] };
    if (row.content !== null) snapshot.content = row.content;
    if (row.reason !== null) snapshot.reason = row.reason;
    derivations.set(`${row.subject_id}/${row.derivation_type}`, snapshot);
  }

  const maxRow = db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as {
    m: number | bigint;
  };

  return { messages, turns, chunks, derivations, maxEventOrder: Number(maxRow.m), derivationCounts, emptyChunkIds };
}

// ── the pure walk ─────────────────────────────────────────────────

export interface SelectionConfig {
  lowerBound: number;
  percentages: { full: number; smooth: number; detailed: number; brief: number };
}

// Message kinds that can anchor a host session rebuild past the compact point.
// Excludes runtime_note (and any future non-mappable kinds). Shared with the
// first-kept-message lookup in compact-compute so "empty tail" means the same
// thing in both places.
export const PI_MAPPABLE_MESSAGE_KINDS = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "tool_call",
  "tool_result",
  "model_change",
  "thinking_level_change",
  "compact_continuation_marker",
] as const;

const PI_MAPPABLE_KIND_SET: ReadonlySet<string> = new Set(PI_MAPPABLE_MESSAGE_KINDS);

function straddlingTurnStaysInFull(
  fullSideTokens: number,
  turnTokens: number,
): boolean {
  const smoothSideTokens = turnTokens - fullSideTokens;
  return fullSideTokens >= smoothSideTokens;
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
    // Fully covered down to the turn's start ⇒ the tail begins at this turn.
    if (oldestTaken.order <= turnStartOrder(candidate)) {
      return previousClose(candidate);
    }

    // A partially-covered closed turn straddles the full-budget line. Round
    // toward the side holding at least half of the turn's tokens (ties stay in
    // full). The split is at the exact budget line, even when that line falls
    // inside the crossing message's estimate.
    const candidateMessages = messagesByTurn.get(candidate.turnId) ?? [];
    const turnTokens = candidateMessages.reduce((total, message) => total + message.tokenEstimate, 0);
    const newerTokens = messages
      .filter((message) => candidate.closedAt !== null && message.order > candidate.closedAt)
      .reduce((total, message) => total + message.tokenEstimate, 0);
    const fullSideTokens = Math.max(0, Math.min(turnTokens, fullBudget - newerTokens));
    if (straddlingTurnStaysInFull(fullSideTokens, turnTokens)) {
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
        : resolveBriefRepresentation(
            chunk.chunkId,
            lookup,
            budget(config.percentages.brief),
            chunkMaterial(chunk.chunkId, "chunk_summary_brief"),
          );
    const text = renderArrangementEntry("chunk", chunk.chunkId, rep, [], chunk.memberTurnIds);
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
  // first crossing entry included only when the band was still empty.
  //
  // What a crossing entry does next depends on the band's position in the
  // ladder. In smooth and detailed it stops the band and cascades the rest to
  // the next band's candidates — that cascade is the ladder working. Brief has
  // no lower band to catch the remainder, so stopping there discarded every
  // older chunk for one unrepresentable entry (the incident: a chunk whose
  // brief derivation failed rendered its whole uncompressed fallback and
  // dropped 45 older chunks that all had healthy briefs). In `skip` mode a
  // crossing entry is passed over and the walk continues to older candidates;
  // the walk ends only when candidates run out or included entries genuinely
  // consume the budget.
  //
  // Passed-over candidates the walk never got older than are not holes — they
  // are the far edge of the window, where a full band has always simply
  // stopped covering. Only a candidate with older entries selected after it
  // is reported as skipped.
  function fillBand<T>(
    candidates: readonly T[], // newest-first
    bandBudget: number,
    build: (candidate: T) => ArrangementEntry,
    crossing: "stop" | "skip" = "stop",
  ): { included: ArrangementEntry[]; rest: T[]; skipped: ArrangementEntry[] } {
    const included: ArrangementEntry[] = [];
    const passedOver: Array<{ entry: ArrangementEntry; includedBefore: number }> = [];
    const reportable = (): ArrangementEntry[] =>
      passedOver.filter((candidate) => candidate.includedBefore < included.length).map((candidate) => candidate.entry);
    let sum = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      if (crossing === "skip" && included.length > 0 && sum >= bandBudget) {
        return { included, rest: candidates.slice(i) as T[], skipped: reportable() };
      }
      const entry = build(candidates[i] as T);
      if (sum + entry.tokens <= bandBudget) {
        included.push(entry);
        sum += entry.tokens;
        continue;
      }
      if (included.length === 0) {
        included.push(entry);
        sum += entry.tokens;
        if (crossing === "stop") return { included, rest: candidates.slice(i + 1) as T[], skipped: [] };
        continue;
      }
      if (crossing === "stop") return { included, rest: candidates.slice(i) as T[], skipped: [] };
      passedOver.push({ entry, includedBefore: included.length });
    }
    return { included, rest: [], skipped: reportable() };
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
  // Rule 4 — brief: the remaining chunks, same fill rule against its share,
  // skipping (not stopping at) entries too large for the remaining budget —
  // this is the last band, so a stop here would drop every older chunk.
  const brief = fillBand(
    detailed.rest,
    budget(config.percentages.brief),
    (chunk) => buildChunkEntry(chunk, "brief"),
    "skip",
  );

  const byRecordOrder = (a: ArrangementEntry, b: ArrangementEntry): number => a.startOrder - b.startOrder;
  const selectedEntries: ArrangementEntry[] = [...brief.included, ...detailed.included, ...smooth.included];

  // Coverage invariant: every closed turn behind the compact point must be
  // represented by a selected turn, represented by a selected chunk's
  // membership, or explicitly surfaced as a smooth gap. This catches the
  // normal open-chunk shape where older closed turns are too old for smooth
  // but cannot be represented by their still-open chunk.
  const coveredTurnIds = new Set<string>();
  const chunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  let oldestSelectedTurnOrder = Number.POSITIVE_INFINITY;
  for (const entry of selectedEntries) {
    if (entry.subjectKind === "turn") {
      coveredTurnIds.add(entry.subjectId);
      const turn = turnsById.get(entry.subjectId);
      if (turn !== undefined) oldestSelectedTurnOrder = Math.min(oldestSelectedTurnOrder, turn.turnOrder);
      continue;
    }
    const chunk = chunksById.get(entry.subjectId);
    for (const turnId of chunk?.memberTurnIds ?? []) {
      const turn = turnsById.get(turnId);
      if (turn !== undefined && bandedTurnIds.has(turnId)) {
        coveredTurnIds.add(turnId);
        oldestSelectedTurnOrder = Math.min(oldestSelectedTurnOrder, turn.turnOrder);
      }
    }
  }

  // A skipped chunk's turns are accounted for — as a recorded gap, not as
  // content. They must not fall through to the coverage machinery, which
  // would answer a hole in the cheapest band with unbudgeted detailed
  // material for every member turn.
  for (const entry of brief.skipped) {
    for (const turnId of chunksById.get(entry.subjectId)?.memberTurnIds ?? []) {
      if (bandedTurnIds.has(turnId)) coveredTurnIds.add(turnId);
    }
  }

  function readyContent(derivation: DerivationSnapshot | undefined): string | null {
    return derivation?.state === "ready" && typeof derivation.content === "string" ? derivation.content : null;
  }

  function derivationState(derivation: DerivationSnapshot | undefined): string {
    return derivation === undefined ? "missing" : derivation.state;
  }

  function buildCoverageEntry(turn: SelectionTurn): ArrangementEntry {
    const compression = lookup(turn.turnId, "detailed_turn_compression");
    const assembly = lookup(turn.turnId, "pre_detailed_assembly");
    const compressionContent = readyContent(compression);
    const assemblyContent = readyContent(assembly);
    const rep =
      compressionContent !== null
        ? {
            derivationUsed: "detailed_turn_compression",
            body: compressionContent,
            degraded: false,
            gap: false,
          }
        : assemblyContent !== null
          ? {
              derivationUsed: "pre_detailed_assembly",
              body: assemblyContent,
              degraded: true,
              gap: false,
              degradedMarker: "coverage-from-pre-detailed-assembly",
              reason: `detailed_turn_compression ${derivationState(compression)}`,
            }
          : {
              derivationUsed: "gap",
              body: "",
              degraded: false,
              gap: true,
              reason: `closed turn before compact point was not represented by selected bands (detailed_turn_compression: ${derivationState(compression)}, pre_detailed_assembly: ${derivationState(assembly)})`,
            };
    const text = renderArrangementEntry("turn", turn.turnId, rep, []);
    const entry: ArrangementEntry = {
      band: "detailed",
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

  const coverageGaps = bandedTurns
    .filter((turn) => turn.turnOrder >= oldestSelectedTurnOrder && !coveredTurnIds.has(turn.turnId))
    .map((turn) => buildCoverageEntry(turn));

  const entries: ArrangementEntry[] = [
    ...brief.included.sort(byRecordOrder),
    ...[...detailed.included, ...coverageGaps].sort(byRecordOrder),
    ...smooth.included.sort(byRecordOrder),
  ];

  // The coverage edge is the oldest INCLUDED entry: a skipped subject inside
  // the window is a hole in coverage that already extends past it, so it
  // neither moves the edge nor ends it.
  const coveredFrom = entries.length === 0 ? compactPoint : Math.min(...entries.map((entry) => entry.startOrder));

  const skipped: SkippedSubject[] = brief.skipped.map((entry) => ({
    band: entry.band,
    subjectId: entry.subjectId,
    tokens: entry.tokens,
    reason: `entry did not fit the remaining ${entry.band} budget (${entry.tokens} tokens from ${entry.derivationUsed}); skipped so older entries could be selected`,
  }));

  return { compactPoint, coveredFrom, entries, skipped };
}
