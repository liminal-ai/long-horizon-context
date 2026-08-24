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
import type { SettleConstruction } from "../../shared-tech/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { StepEdges } from "../../turns/internal/steps.js";
import { DEFAULT_NEWEST_CLOSED_PROTECTION } from "./profiles.js";
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
/** One part's step range, in host step indices. */
export interface PartRange {
  fromStep: number;
  toStep: number;
}

/** The installed view's transition turn: the one turn served as parts. */
export interface InstalledTransition {
  turnId: string;
  parts: PartRange[];
}

/**
 * Turn parts: what the walk asks for beyond the band inputs. Absent on the
 * legacy plan, so the legacy walk can neither split nor settle. Step edges and
 * constructions are hydration points, reached only when a split or settle is
 * actually decided.
 */
export interface PartsSource {
  readonly installed: InstalledTransition | null;
  turnSteps(turnId: string): StepEdges;
  partText(turnId: string, range: { fromOrder: number; toOrder: number }, trailer: string): string;
  wholeTurnText(turnId: string): string | null;
}

export interface SelectionSource {
  /** Turn parts source; undefined on the legacy plan. */
  readonly parts?: PartsSource;
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

/**
 * The seam line a part ends with: identity, range, direction — nothing else.
 * Position-independent by design: a part's bytes must not change when a later
 * compact appends another part after it (AC-4.1b), so the last part's marker
 * reads the same whether the tail or another part follows.
 */
export function seamMarker(turnId: string, range: PartRange): string {
  return `[seam · ${turnId} · steps ${range.fromStep}–${range.toStep} summarized above · ${turnId} resumes below]`;
}

// Ordinal k for a part range: how many steps of the turn the parts through
// `toStep` cover. Zero when the step is unknown to the record.
function ordinalThrough(steps: StepEdges, toStep: number): number {
  const at = steps.steps.findIndex((step) => step.index === toStep);
  return at < 0 ? 0 : at + 1;
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
  const openTurn = turns.find((turn) => turn.status === "open");
  // A compact point upper bound is the protected-pair clamp of the
  // forced-boundary runtime. Per-thread exclusivity (AC-7.3) means it never
  // meets a thread that has served parts; if it does, the invariant is
  // broken above this walk and the walk says so rather than splitting under
  // a clamp it cannot honor. Under a bound on a clean thread, no split.
  if (config.compactPointUpperBound !== undefined && source.parts?.installed !== null && source.parts !== undefined) {
    throw new Error(
      `turn parts invariant violated: compactPointUpperBound on a thread serving parts of ${source.parts.installed.turnId}`,
    );
  }
  const partsSource = config.compactPointUpperBound === undefined ? source.parts : undefined;
  let compactPoint = 0;
  // The crossing is read whenever a closed turn can be banded — and, with a
  // parts source, whenever the open turn alone could need splitting.
  const crossing =
    (closedTurns.length > 0 || partsSource !== undefined) && source.hasPlaceableMessages()
      ? source.crossingMessage(fullBudget)
      : null;
  if (closedTurns.length > 0) {
    // Budget never reached ⇒ the whole record fits the full share:
    // everything is tail, no bands.
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

  // ── turn parts: the transition turn, settle, and the split point ──
  //
  // The installed view names at most one transition turn. When it is closed,
  // it settles here iff the ordinary compact point would band it (the walk
  // never serves it whole-unsettled: short of settle it keeps its parts and
  // the compact point stays on its installed edge). Only with no other turn
  // left unsettled may the open turn split, at the smallest complete step
  // edge whose verbatim tail fits the full share (inclusive), clamped up to
  // the installed k so a split point never moves backward.
  let settling: SelectionTurn | null = null;
  let settledRecord: SelectionResult["settled"];
  let partsPlan: { turn: SelectionTurn; steps: StepEdges; ranges: PartRange[] } | null = null;
  if (partsSource !== undefined) {
    const installed = partsSource.installed;
    const installedTurn = installed === null ? undefined : turnsById.get(installed.turnId);
    if (installed !== null && installedTurn !== undefined && installed.parts.length > 0) {
      const steps = partsSource.turnSteps(installedTurn.turnId);
      const lastInstalled = installed.parts[installed.parts.length - 1] as PartRange;
      const installedEdge = steps.steps.find((step) => step.index === lastInstalled.toStep)?.lastOrder;
      if (installedTurn.status === "closed" && installedTurn.closedAt !== null) {
        if (compactPoint >= installedTurn.closedAt) {
          settling = installedTurn;
        } else if (installedEdge !== undefined) {
          compactPoint = installedEdge;
          partsPlan = { turn: installedTurn, steps, ranges: [...installed.parts] };
        }
      }
    }
    if (partsPlan === null && openTurn !== undefined) {
      const prior =
        installed !== null && installed.turnId === openTurn.turnId && installed.parts.length > 0 ? installed : null;
      const steps = partsSource.turnSteps(openTurn.turnId);
      const priorK =
        prior === null ? 0 : ordinalThrough(steps, (prior.parts[prior.parts.length - 1] as PartRange).toStep);
      const kMax = steps.splittable ? (steps.lastEdge ?? 0) : priorK;
      let kComputed = 0;
      if (crossing !== null && crossing.turnId === openTurn.turnId && kMax > 0) {
        // The open turn alone reaches the full share. Smallest k whose tail
        // fits (<=); when none does, the minimum verbatim tail is served —
        // elder bands absorb the overrun.
        kComputed = kMax;
        for (let k = 1; k <= kMax; k += 1) {
          const edge = (steps.steps[k - 1] as StepEdges["steps"][number]).lastOrder;
          if (source.messageTokensAfter(edge) <= fullBudget) {
            kComputed = k;
            break;
          }
        }
      }
      const k = Math.max(kComputed, priorK);
      if (k > 0) {
        compactPoint = (steps.steps[k - 1] as StepEdges["steps"][number]).lastOrder;
        const ranges = prior === null ? [] : [...prior.parts];
        if (k > priorK) {
          ranges.push({
            fromStep: (steps.steps[priorK] as StepEdges["steps"][number]).index,
            toStep: (steps.steps[k - 1] as StepEdges["steps"][number]).index,
          });
        }
        partsPlan = { turn: openTurn, steps, ranges };
      }
    }
  }

  // ── Flow 5: the newest closed turn is protected by placement ──
  //
  // Precedence: (1) the active turn's minimum verbatim tail; (2) the newest
  // closed turn full when its verbatim cost fits min(fraction × lower bound,
  // what (1) left); (3)–(4) the extended tail and elder bands take the rest.
  //
  // The served view is contiguous — bands, then one verbatim tail from the
  // compact point — so a full newest closed turn puts everything newer than
  // it in the tail too. Under a planned split, (1) therefore reserves the
  // whole active turn, and a turn already served as parts can never be
  // followed by a full closed turn (k never moves backward). A turn that does
  // not fit takes its whole deterministic rendering — stored or composed
  // in-walk — never an excerpt. Requires the parts source (the bounded plan
  // on a clean thread): the legacy plan is byte-unchanged.
  let protectedRecord: SelectionResult["protectedTurn"];
  let protectedOverrun = 0;
  const newestClosed = closedTurns.length === 0 ? undefined : closedTurns[closedTurns.length - 1];
  const transitionTurnId = partsPlan?.turn.turnId ?? settling?.turnId ?? null;
  if (
    partsSource !== undefined &&
    newestClosed !== undefined &&
    newestClosed.closedAt !== null &&
    newestClosed.turnId !== transitionTurnId &&
    newestClosed.closedAt <= compactPoint
  ) {
    const fraction = config.newestClosedProtection ?? DEFAULT_NEWEST_CLOSED_PROTECTION;
    const activeAlreadySplit = partsSource.installed !== null && partsSource.installed.turnId === openTurn?.turnId;
    const reserve =
      partsPlan !== null && openTurn !== undefined
        ? source.turnMessageTokens(openTurn.turnId)
        : source.messageTokensAfter(compactPoint);
    const bound = Math.min(fraction * config.lowerBound, config.lowerBound - reserve);
    const verbatimCost = source.turnMessageTokens(newestClosed.turnId);
    if (!activeAlreadySplit && verbatimCost <= bound) {
      const previous = closedTurns.filter((t) => t.turnOrder < newestClosed.turnOrder).at(-1);
      compactPoint = previous?.closedAt ?? 0;
      partsPlan = null;
      protectedRecord = { turnId: newestClosed.turnId, representation: "full" };
      protectedOverrun = Math.max(0, source.messageTokensAfter(compactPoint) - fullBudget);
    } else {
      protectedRecord = { turnId: newestClosed.turnId, representation: "whole_rendering" };
    }
  }

  // Band candidates: closed turns wholly behind the compact point. Rule 5 is
  // structural here — chunked or not, a banded turn is a smooth candidate
  // (bands are defined by representation, not strict time strata).
  const bandedTurns = closedTurns.filter((turn) => turn.closedAt !== null && turn.closedAt <= compactPoint);
  const bandedTurnIds = new Set(bandedTurns.map((turn) => turn.turnId));

  // The whole construction from canonical — the stored rendering when ready,
  // else composed in-walk — with the construction reference the settle record
  // carries. Never the excerpt or compression rung.
  function resolveWholeConstruction(
    turn: SelectionTurn,
  ): { rep: ReturnType<typeof resolveSmoothRepresentation>; construction: SettleConstruction } | null {
    const rendering = lookup(turn.turnId, "turn_rendering");
    if (rendering?.state === "ready" && typeof rendering.content === "string") {
      return {
        rep: { derivationUsed: "turn_rendering", body: rendering.content, degraded: false, gap: false },
        construction: {
          kind: "stored",
          subjectId: turn.turnId,
          derivationType: "turn_rendering",
          sourceVersion: rendering.sourceVersion ?? 1,
        },
      };
    }
    const composed = partsSource?.wholeTurnText(turn.turnId) ?? null;
    if (composed !== null) {
      return {
        rep: { derivationUsed: "composed_in_walk", body: composed, degraded: false, gap: false },
        construction: { kind: "composed_in_walk", turnId: turn.turnId },
      };
    }
    return null;
  }

  function buildTurnEntry(turn: SelectionTurn): ArrangementEntry {
    let rep: ReturnType<typeof resolveSmoothRepresentation> | null = null;
    if (settling !== null && settling.turnId === turn.turnId) {
      const whole = resolveWholeConstruction(turn);
      if (whole !== null) {
        settledRecord = { turnId: turn.turnId, construction: whole.construction };
        rep = whole.rep;
      }
    } else if (protectedRecord?.representation === "whole_rendering" && protectedRecord.turnId === turn.turnId) {
      rep = resolveWholeConstruction(turn)?.rep ?? null;
    }
    rep ??= resolveSmoothRepresentation(turn.turnId, lookup, () => source.turnExcerpt(turn.turnId));
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

  // Turn parts: one entry per part, composed independently over its own
  // order span, each ending in its seam line. Parts are the newest smooth
  // material and are always included; they consume the smooth share first.
  const partEntries: ArrangementEntry[] = [];
  if (partsPlan !== null && partsSource !== undefined) {
    const { turn, steps, ranges } = partsPlan;
    let fromOrder = turnStartOrder(turn);
    for (const range of ranges) {
      const toOrder = steps.steps.find((step) => step.index === range.toStep)?.lastOrder;
      if (toOrder === undefined)
        throw new Error(`turn parts: installed part ${turn.turnId} step ${range.toStep} is unknown to the record`);
      const text = partsSource.partText(turn.turnId, { fromOrder, toOrder }, seamMarker(turn.turnId, range));
      partEntries.push({
        band: "smooth",
        subjectKind: "turn",
        subjectId: turn.turnId,
        derivationUsed: "part",
        degraded: false,
        gap: false,
        startOrder: fromOrder,
        text,
        tokens: estimateTokens(text),
        part: range,
      });
      fromOrder = toOrder + 1;
    }
  }
  const partTokens = partEntries.reduce((sum, entry) => sum + entry.tokens, 0);

  // Rule 2 + 5 — smooth band: banded closed turns newest-first, chunked or
  // not (rule 5 is structural: a closed-but-unchunked turn is a turn, takes
  // the smooth representation, and consumes this budget).
  const smooth = fillBand(
    [...bandedTurns].reverse(),
    Math.max(0, budget(config.percentages.smooth) - partTokens - protectedOverrun),
    buildTurnEntry,
  );
  smooth.included.push(...partEntries);
  const oldestSmoothOrder = smooth.included
    .filter((entry) => entry.part === undefined)
    .reduce(
      (oldest, entry) => Math.min(oldest, turnsById.get(entry.subjectId)?.turnOrder ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );

  // Rules 3–4 — chunk candidacy: chunks entirely older than the smooth
  // band's coverage, with the pinned tie-breaker doing the deciding — chunk
  // coverage is its NEWEST member turn, which must sit behind the compact
  // point and be older than the smooth band's oldest included turn.
  // A chunk holding the still-unsettled transition turn is not a band
  // candidate until that turn settles.
  const unsettledClosedTurnId = partsPlan !== null && partsPlan.turn.status === "closed" ? partsPlan.turn.turnId : null;
  const chunkCandidates = chunks
    .filter((chunk) => chunk.status === "closed")
    .filter((chunk) => unsettledClosedTurnId === null || !chunk.memberTurnIds.includes(unsettledClosedTurnId))
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

  // The one invariant: at most one turn is unsettled at compact completion,
  // and a turn settled here is not also served as parts.
  const unsettled = new Set(entries.filter((entry) => entry.part !== undefined).map((entry) => entry.subjectId));
  if (unsettled.size > 1 || (settling !== null && unsettled.has(settling.turnId))) {
    throw new Error(`turn parts invariant violated: unsettled turns [${[...unsettled].join(", ")}]`);
  }

  const result: SelectionResult = { compactPoint, coveredFrom, entries, skipped };
  if (partsPlan !== null) {
    result.parts = partsPlan.ranges.map((range) => ({ turnId: partsPlan!.turn.turnId, ...range }));
    result.splitPoint = {
      turnId: partsPlan.turn.turnId,
      stepIndex: (partsPlan.ranges[partsPlan.ranges.length - 1] as PartRange).toStep,
    };
  }
  if (settledRecord !== undefined) result.settled = settledRecord;
  if (protectedRecord !== undefined) result.protectedTurn = protectedRecord;
  return result;
}
