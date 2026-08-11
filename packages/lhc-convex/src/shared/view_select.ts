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
// Crossing entries: smooth and detailed stop at the first entry that does not
// fit and hand the remainder to the band below. Brief is the last band, so
// there is no band below to catch the remainder: it skips the crossing entry
// and keeps walking to older candidates, reporting each skip as a gap note.
import type { Band } from "../client/types.js";
import { estimateTokens } from "./token_counting/index.js";
import {
  type CompactChunkMaterialSnapshot,
  type DerivationSnapshot,
  renderArrangementEntry,
  resolveBriefRepresentation,
  resolveDetailedRepresentation,
  resolveSmoothRepresentation,
} from "./view_render.js";

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

// A candidate the last band's walk passed over: too large for what was left of
// the budget, with older candidates still selected after it. No entry is
// rendered for it, so it is a hole in the coverage window — reported alongside
// gap entries wherever the view's gaps are serialized.
export interface SkippedEntry {
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
  // Newest-first, in walk order.
  skipped: SkippedEntry[];
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
] as const;

const PI_MAPPABLE_KIND_SET: ReadonlySet<string> = new Set(PI_MAPPABLE_MESSAGE_KINDS);

function straddlingTurnStaysInFull(
  fullSideTokens: number,
  turnTokens: number,
  evictionWouldEmptyFull: boolean,
): boolean {
  if (evictionWouldEmptyFull) return true;
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
  // The brief band's own budget, needed by the brief ladder's failure floor as
  // well as by its fill.
  const briefBudget = budget(config.percentages.brief);

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

    // A partially-covered closed turn straddles the full-budget line. Keep it
    // whole in full when evicting it would leave no live tail; otherwise round
    // toward the side holding at least half of the turn's tokens (ties stay in
    // full). The split is at the exact budget line, even when that line falls
    // inside the crossing message's estimate.
    const candidateMessages = messagesByTurn.get(candidate.turnId) ?? [];
    const turnTokens = candidateMessages.reduce((total, message) => total + message.tokenEstimate, 0);
    const newerTokens = messages
      .filter((message) => candidate.closedAt !== null && message.order > candidate.closedAt)
      .reduce((total, message) => total + message.tokenEstimate, 0);
    const fullSideTokens = Math.max(0, Math.min(turnTokens, fullBudget - newerTokens));
    // Empty = no mappable live messages past the candidate — runtime_note alone
    // does not count as a rebuildable tail.
    const evictionWouldEmptyFull = !messages.some(
      (message) =>
        candidate.closedAt !== null && message.order > candidate.closedAt && PI_MAPPABLE_KIND_SET.has(message.kind),
    );
    if (straddlingTurnStaysInFull(fullSideTokens, turnTokens, evictionWouldEmptyFull)) {
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
            briefBudget,
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

  // What a band does with an entry that does not fit what is left of its
  // budget: "stop" ends the band and hands the crossing entry and everything
  // older to the band below; "skip" passes over it and keeps walking, for the
  // last band, which has no band below to hand a remainder to.
  type CrossingMode = "stop" | "skip";

  // The one fill rule, shared by all three bands: newest-first whole-entry
  // fill, <= inclusion (an entry exactly filling the budget is included), the
  // first crossing entry stops the band (or, in skip mode, is passed over),
  // force-included only when the band was still empty.
  function fillBand<T>(
    candidates: readonly T[], // newest-first
    bandBudget: number,
    build: (candidate: T) => ArrangementEntry,
    mode: CrossingMode = "stop",
  ): { included: ArrangementEntry[]; skipped: SkippedEntry[]; rest: T[] } {
    const included: ArrangementEntry[] = [];
    // Each skip is held with the inclusion count at the moment it was passed
    // over: a skip is only worth reporting when something older was selected
    // after it. The ordinary window edge — the band simply running out of room
    // at its oldest candidates — stays quiet.
    const passedOver: Array<{ skip: SkippedEntry; includedBefore: number }> = [];
    const report = (rest: T[]): { included: ArrangementEntry[]; skipped: SkippedEntry[]; rest: T[] } => ({
      included,
      skipped: passedOver.filter((held) => included.length > held.includedBefore).map((held) => held.skip),
      rest,
    });
    let sum = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const entry = build(candidates[i] as T);
      if (sum + entry.tokens <= bandBudget) {
        included.push(entry);
        sum += entry.tokens;
        continue;
      }
      if (included.length === 0) {
        // Force-include: a band that would otherwise render empty takes its
        // newest candidate whole, over budget. It costs the band its whole
        // budget and then some, so in skip mode the walk stops there too —
        // nothing older can fit behind it.
        included.push(entry);
        sum += entry.tokens;
        if (mode === "stop" || sum >= bandBudget) return report(candidates.slice(i + 1) as T[]);
        continue;
      }
      if (mode === "stop") return report(candidates.slice(i) as T[]);
      passedOver.push({
        skip: {
          band: entry.band,
          subjectId: entry.subjectId,
          tokens: entry.tokens,
          reason: `entry did not fit the remaining ${entry.band} budget (${entry.tokens} tokens from ${entry.derivationUsed}); skipped so older entries could be selected`,
        },
        includedBefore: included.length,
      });
    }
    return report([]);
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
  // in skip mode — brief is the last band, so one unrepresentable chunk must
  // never end processing of everything older than it.
  const brief = fillBand(detailed.rest, briefBudget, (chunk) => buildChunkEntry(chunk, "brief"), "skip");
  // Only the last band skips; the handoff bands cascade instead.
  const skipped = brief.skipped;

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

  // A skipped chunk is a hole the gap note already reports. Its member turns
  // count as covered so the coverage sweep below does not answer that hole
  // with unbudgeted detailed turn entries — the one thing the band budget
  // cannot absorb. The skip does not move oldestSelectedTurnOrder: nothing was
  // selected.
  for (const skip of skipped) {
    const chunk = chunksById.get(skip.subjectId);
    for (const turnId of chunk?.memberTurnIds ?? []) {
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

  const coveredFrom = entries.length === 0 ? compactPoint : Math.min(...entries.map((entry) => entry.startOrder));

  return { compactPoint, coveredFrom, entries, skipped };
}
