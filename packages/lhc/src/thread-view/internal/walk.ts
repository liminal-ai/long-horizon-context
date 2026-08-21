// The band walk itself: compact point, smooth/detailed/brief fills, coverage
// gaps, and the coverage edge. One implementation, parameterised over a
// SelectionSource, so the two execution plans — the eager one that hydrates
// every live message and every closed chunk's fallback material up front, and
// the bounded one that reads metadata aggregates and hydrates only what the
// walk visits — differ in what they load, never in what they decide.
//
// The source contract is deliberately split: metadata answers (does a message
// exist, which message crosses the full budget, a turn's oldest message order
// and token sum) are always available and always cheap; excerpt text and chunk
// fallback material are asked for only on the rung that would render them, so
// a candidate the walk passes over is never hydrated.
//
// Tie-breakers: inclusion thresholds are <=; walks are newest-first everywhere;
// chunk coverage is decided by the chunk's newest member turn. Entry costs are
// the tokens of the rendered entry text itself, so the budgeted tokens are the
// stored tokens — no second estimate.
//
// An entry too large for its band's remaining budget stops smooth and detailed
// (the rest cascades to the next band's candidates) but only skips in brief:
// brief is the last band, and one unrepresentable entry may not end the walk
// over everything older. A skipped subject renders no band text; it is
// reported as a gap (SelectionResult.skipped) and covered_from runs to the
// oldest INCLUDED entry, so coverage extends past the hole.
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import {
  type CompactChunkMaterialSnapshot,
  type DerivationSnapshot,
  renderArrangementEntry,
  resolveBriefRepresentation,
  resolveDetailedRepresentation,
  resolveSmoothRepresentation,
} from "./render.js";
import type {
  ArrangementEntry,
  ChunkSummaryType,
  SelectionChunk,
  SelectionConfig,
  SelectionResult,
  SelectionTurn,
  SkippedSubject,
} from "./select.js";

/**
 * What the walk may ask of the record. Structure is eager because it is
 * bounded by turn and chunk counts; message facts are aggregates; excerpt and
 * fallback material are hydration points, reached only from the ladder rung
 * that renders them.
 */
export interface SelectionSource {
  /** Live turns, ascending turnOrder. */
  readonly turns: readonly SelectionTurn[];
  /** Chunks the walk can place, ascending chunkOrder. */
  readonly chunks: readonly SelectionChunk[];
  /** Whether the record holds any live, placeable message at all. */
  hasPlaceableMessages(): boolean;
  /** Newest-first: the first live message whose running token sum reaches `budget`. */
  crossingMessage(budget: number): { order: number; turnId: string } | null;
  /** The turn's oldest live message order; undefined when it has none. */
  turnMinMessageOrder(turnId: string): number | undefined;
  /** Token-estimate sum of the turn's live messages (0 when it has none). */
  turnMessageTokens(turnId: string): number;
  /** Token-estimate sum of every live message newer than `order`. */
  messageTokensAfter(order: number): number;
  /** The turn's excerpt lines joined; null when the turn has no live messages. */
  turnExcerpt(turnId: string): string | null;
  derivation(subjectId: string, derivationType: string): DerivationSnapshot | undefined;
  /** Stored fallback material; undefined when the caller did not ask for it. */
  chunkMaterial(chunkId: string, derivationType: ChunkSummaryType): CompactChunkMaterialSnapshot | undefined;
}

function straddlingTurnStaysInFull(fullSideTokens: number, turnTokens: number): boolean {
  const smoothSideTokens = turnTokens - fullSideTokens;
  return fullSideTokens >= smoothSideTokens;
}

export function walkArrangement(source: SelectionSource, config: SelectionConfig): SelectionResult {
  const { turns, chunks } = source;
  const lookup = (subjectId: string, derivationType: string): DerivationSnapshot | undefined =>
    source.derivation(subjectId, derivationType);
  const budget = (share: number): number => (config.lowerBound * share) / 100;

  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));

  // The oldest event order a turn's entry represents: its oldest live
  // message, falling back to its open boundary.
  function turnStartOrder(turn: SelectionTurn): number {
    return source.turnMinMessageOrder(turn.turnId) ?? turn.openedAt;
  }

  // Rule 1 — compact point: messages newest-first until the estimate sum
  // first reaches the full share; the point snaps to a turn boundary so the
  // tail never begins mid-turn. Open-turn messages always land in the tail.
  const fullBudget = budget(config.percentages.full);
  const closedTurns = turns.filter((turn) => turn.status === "closed");
  let compactPoint = 0;
  if (closedTurns.length > 0 && source.hasPlaceableMessages()) {
    // Budget never reached ⇒ the whole record fits the full share:
    // everything is tail, no bands.
    const crossing = source.crossingMessage(fullBudget);
    compactPoint = crossing === null ? 0 : snapCompactPoint(crossing);
  }
  if (config.compactPointUpperBound !== undefined && compactPoint > config.compactPointUpperBound) {
    // Snap backward to the greatest legal closed-turn boundary <= the upper
    // bound. Compact points must land on a real turn.closedAt (or 0); a raw
    // numeric clamp could split a turn and violate selector/view invariants.
    const legalBoundaries = closedTurns
      .filter((t) => t.closedAt !== null && t.closedAt <= config.compactPointUpperBound!)
      .map((t) => t.closedAt as number);
    compactPoint = legalBoundaries.length > 0 ? Math.max(...legalBoundaries) : 0;
  }

  function snapCompactPoint(oldestTaken: { order: number; turnId: string }): number {
    const candidate = turnsById.get(oldestTaken.turnId);
    const previousClose = (turn: SelectionTurn): number => {
      const previous = closedTurns.filter((t) => t.turnOrder < turn.turnOrder).at(-1);
      return previous?.closedAt ?? 0;
    };
    // Every selected message resolves to a live turn: the source's message
    // population skipped the ones that do not.
    if (candidate === undefined) return 0;
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
    const turnTokens = source.turnMessageTokens(candidate.turnId);
    const newerTokens = candidate.closedAt === null ? 0 : source.messageTokensAfter(candidate.closedAt);
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
    const rep = resolveSmoothRepresentation(turn.turnId, lookup, () => source.turnExcerpt(turn.turnId));
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
        ? resolveDetailedRepresentation(chunk.chunkId, lookup, () =>
            source.chunkMaterial(chunk.chunkId, "chunk_summary_detailed"),
          )
        : resolveBriefRepresentation(chunk.chunkId, lookup, budget(config.percentages.brief), () =>
            source.chunkMaterial(chunk.chunkId, "chunk_summary_brief"),
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
