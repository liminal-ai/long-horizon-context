import type { SettleConstruction } from "../../shared-tech/index.js";
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
import type { InstalledTransition, PartRange } from "./snapshot.js";

export interface PartsSource {
  readonly installed: InstalledTransition | null;
  turnSteps(turnId: string): StepEdges;
  partText(turnId: string, range: { fromOrder: number; toOrder: number }, trailer: string): string;
  wholeTurnText(turnId: string): { text: string; capped: boolean } | null;
}

export interface SelectionSource {
  readonly parts?: PartsSource;
  readonly turns: readonly SelectionTurn[];
  readonly chunks: readonly SelectionChunk[];
  hasPlaceableMessages(): boolean;
  crossingMessage(budget: number): { order: number; turnId: string } | null;
  turnMinMessageOrder(turnId: string): number | undefined;
  turnMessageTokens(turnId: string): number;
  messageTokensAfter(order: number): number;
  turnExcerpt(turnId: string): string | null;
  derivation(subjectId: string, derivationType: string): DerivationSnapshot | undefined;
  chunkMaterial(chunkId: string, derivationType: ChunkSummaryType): CompactChunkMaterialSnapshot | undefined;
}

export function seamMarker(turnId: string, range: PartRange): string {
  return `[seam · ${turnId} · steps ${range.fromStep}–${range.toStep} summarized above · ${turnId} resumes below]`;
}

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
  const estimator = config.tokenEstimator;
  const lookup = (subjectId: string, derivationType: string): DerivationSnapshot | undefined =>
    source.derivation(subjectId, derivationType);
  const budget = (share: number): number => (config.lowerBound * share) / 100;

  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));

  function turnStartOrder(turn: SelectionTurn): number {
    return source.turnMinMessageOrder(turn.turnId) ?? turn.openedAt;
  }

  const fullBudget = budget(config.percentages.full);
  const closedTurns = turns.filter((turn) => turn.status === "closed");
  const openTurn = turns.find((turn) => turn.status === "open");
  if (config.compactPointUpperBound !== undefined && source.parts?.installed !== null && source.parts !== undefined) {
    throw new Error(
      `turn parts invariant violated: compactPointUpperBound on a thread serving parts of ${source.parts.installed.turnId}`,
    );
  }
  const partsSource = config.compactPointUpperBound === undefined ? source.parts : undefined;
  let compactPoint = 0;
  const crossing =
    (closedTurns.length > 0 || partsSource !== undefined) && source.hasPlaceableMessages()
      ? source.crossingMessage(fullBudget)
      : null;
  if (closedTurns.length > 0) {
    compactPoint = crossing === null ? 0 : snapCompactPoint(crossing);
  }
  if (config.compactPointUpperBound !== undefined && compactPoint > config.compactPointUpperBound) {
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
    if (candidate === undefined) return 0;
    if (candidate.status === "open") {
      return previousClose(candidate);
    }
    if (oldestTaken.order <= turnStartOrder(candidate)) {
      return previousClose(candidate);
    }

    const turnTokens = source.turnMessageTokens(candidate.turnId);
    const newerTokens = candidate.closedAt === null ? 0 : source.messageTokensAfter(candidate.closedAt);
    const fullSideTokens = Math.max(0, Math.min(turnTokens, fullBudget - newerTokens));
    if (straddlingTurnStaysInFull(fullSideTokens, turnTokens)) {
      return previousClose(candidate);
    }
    return candidate.closedAt ?? 0;
  }

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
        if (source.messageTokensAfter(installedTurn.closedAt) >= fullBudget) {
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

  let protectedRecord: SelectionResult["protectedTurn"];
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
    } else {
      protectedRecord = { turnId: newestClosed.turnId, representation: "whole_rendering" };
    }
  }

  const bandedTurns = closedTurns.filter((turn) => turn.closedAt !== null && turn.closedAt <= compactPoint);
  const bandedTurnIds = new Set(bandedTurns.map((turn) => turn.turnId));

  type WholeConstruction = { rep: ReturnType<typeof resolveSmoothRepresentation>; construction: SettleConstruction };

  function resolveWholeConstruction(turn: SelectionTurn, requireStored: boolean): WholeConstruction | null {
    const rendering = lookup(turn.turnId, "turn_rendering");
    const stored = rendering?.state === "ready" && typeof rendering.content === "string" ? rendering.content : null;
    if (stored === null && requireStored) return null;
    const composed = partsSource?.wholeTurnText(turn.turnId) ?? null;
    if (stored !== null && (composed === null || !composed.capped)) {
      return {
        rep: { derivationUsed: "turn_rendering", body: stored, degraded: false, gap: false },
        construction: {
          kind: "stored",
          subjectId: turn.turnId,
          derivationType: "turn_rendering",
          sourceVersion: rendering?.sourceVersion ?? 1,
        },
      };
    }
    if (composed !== null) {
      return {
        rep: { derivationUsed: "composed_in_walk", body: composed.text, degraded: false, gap: false },
        construction: { kind: "composed_in_walk", turnId: turn.turnId },
      };
    }
    return null;
  }

  function buildTurnEntry(turn: SelectionTurn): ArrangementEntry {
    let rep: ReturnType<typeof resolveSmoothRepresentation> | null = null;
    if (settling !== null && settling.turnId === turn.turnId) {
      const whole = resolveWholeConstruction(turn, false);
      if (whole !== null) {
        settledRecord = { turnId: turn.turnId, construction: whole.construction };
        rep = whole.rep;
      }
    } else if (protectedRecord?.representation === "whole_rendering" && protectedRecord.turnId === turn.turnId) {
      rep = resolveWholeConstruction(turn, false)?.rep ?? null;
    } else if (partsSource !== undefined) {
      rep = resolveWholeConstruction(turn, true)?.rep ?? null;
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
      tokens: estimator.estimate(text),
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
        : resolveBriefRepresentation(chunk.chunkId, lookup, budget(config.percentages.brief), estimator, () =>
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
      tokens: estimator.estimate(text),
    };
    if (rep.reason !== undefined) entry.reason = rep.reason;
    return entry;
  }

  function fillBand<T>(
    candidates: readonly T[], // newest-first
    bandBudget: number,
    build: (candidate: T) => ArrangementEntry,
    crossing: "stop" | "skip" = "stop",
    admitFirst = true,
    prior: readonly ArrangementEntry[] = [],
  ): { included: ArrangementEntry[]; rest: T[]; skipped: ArrangementEntry[] } {
    if (!admitFirst && bandBudget <= 0) return { included: [], rest: [...candidates], skipped: [] };
    const included: ArrangementEntry[] = [];
    const passedOver: Array<{ entry: ArrangementEntry; includedBefore: number }> = [];
    const reportable = (): ArrangementEntry[] =>
      passedOver.filter((candidate) => candidate.includedBefore < included.length).map((candidate) => candidate.entry);
    const held = (): number => prior.length + included.length;
    let sum = prior.reduce((total, entry) => total + entry.tokens, 0);
    for (let i = 0; i < candidates.length; i += 1) {
      if (crossing === "skip" && held() > 0 && sum >= bandBudget) {
        return { included, rest: candidates.slice(i) as T[], skipped: reportable() };
      }
      const entry = build(candidates[i] as T);
      if (sum + entry.tokens <= bandBudget) {
        included.push(entry);
        sum += entry.tokens;
        continue;
      }
      if (held() === 0) {
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
        tokens: estimator.estimate(text),
        part: range,
      });
      fromOrder = toOrder + 1;
    }
  }
  const partTokens = partEntries.reduce((sum, entry) => sum + entry.tokens, 0);

  const mechanismPlacement = partsPlan !== null || settling !== null || protectedRecord !== undefined;
  const tailOverrun = mechanismPlacement ? Math.max(0, source.messageTokensAfter(compactPoint) - fullBudget) : 0;

  const mandatoryTurnIds = new Set<string>();
  if (settling !== null) mandatoryTurnIds.add(settling.turnId);
  if (protectedRecord?.representation === "whole_rendering") mandatoryTurnIds.add(protectedRecord.turnId);
  const mandatoryEntries = bandedTurns.filter((turn) => mandatoryTurnIds.has(turn.turnId)).map(buildTurnEntry);
  const mandatoryTokens = mandatoryEntries.reduce((sum, entry) => sum + entry.tokens, 0);
  let carry = partTokens + mandatoryTokens + tailOverrun;
  const cascading = carry > 0;
  const shareAfterCarry = (percentage: number): number => {
    const share = budget(percentage);
    const usable = Math.max(0, share - carry);
    carry = Math.max(0, carry - share);
    return usable;
  };
  const smoothBudget = shareAfterCarry(config.percentages.smooth);
  const detailedBudget = shareAfterCarry(config.percentages.detailed);
  const briefBudget = shareAfterCarry(config.percentages.brief);

  const smooth = fillBand(
    [...bandedTurns].reverse().filter((turn) => !mandatoryTurnIds.has(turn.turnId)),
    smoothBudget,
    buildTurnEntry,
    "stop",
    !cascading,
  );
  smooth.included.push(...mandatoryEntries, ...partEntries);
  const oldestSmoothOrder = smooth.included
    .filter((entry) => entry.part === undefined)
    .reduce(
      (oldest, entry) => Math.min(oldest, turnsById.get(entry.subjectId)?.turnOrder ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );

  const unsettledClosedTurnId = partsPlan !== null && partsPlan.turn.status === "closed" ? partsPlan.turn.turnId : null;
  const chunkCandidates: SelectionChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.status !== "closed") continue;
    if (unsettledClosedTurnId !== null && chunk.memberTurnIds.includes(unsettledClosedTurnId)) continue;
    const liveMembers = chunk.memberTurnIds
      .map((turnId) => turnsById.get(turnId))
      .filter((turn): turn is SelectionTurn => turn !== undefined);
    if (liveMembers.length === 0) continue;
    const newestMember = liveMembers.reduce((newest, turn) => (turn.turnOrder > newest.turnOrder ? turn : newest));
    if (bandedTurnIds.has(newestMember.turnId) && newestMember.turnOrder < oldestSmoothOrder) {
      chunkCandidates.push(chunk);
    }
  }
  const chunkCandidateTurnIds = new Set(chunkCandidates.flatMap((chunk) => chunk.memberTurnIds));
  const elderTurns = bandedTurns.filter(
    (turn) => turn.turnOrder < oldestSmoothOrder && !chunkCandidateTurnIds.has(turn.turnId),
  );
  chunkCandidates.reverse();

  const detailed = fillBand(
    chunkCandidates,
    detailedBudget,
    (chunk) => buildChunkEntry(chunk, "detailed"),
    "stop",
    !cascading,
  );
  const brief = fillBand(detailed.rest, briefBudget, (chunk) => buildChunkEntry(chunk, "brief"), "skip", !cascading);

  const byRecordOrder = (a: ArrangementEntry, b: ArrangementEntry): number => a.startOrder - b.startOrder;
  const selectedEntries: ArrangementEntry[] = [...brief.included, ...detailed.included, ...smooth.included];

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

  for (const entry of brief.skipped) {
    for (const turnId of chunksById.get(entry.subjectId)?.memberTurnIds ?? []) {
      if (bandedTurnIds.has(turnId)) coveredTurnIds.add(turnId);
    }
  }

  const hasReadyTurnSummary = (turn: SelectionTurn): boolean =>
    readyContent(lookup(turn.turnId, "detailed_turn_compression")) !== null ||
    readyContent(lookup(turn.turnId, "pre_detailed_assembly")) !== null;
  const orphanedMembers = elderTurns
    .filter((turn) => turn.turnOrder < oldestSelectedTurnOrder && !coveredTurnIds.has(turn.turnId))
    .sort((a, b) => b.turnOrder - a.turnOrder);
  const settledElderTurnIds = new Set(orphanedMembers.map((turn) => turn.turnId));
  const markerMembers = new Map<ArrangementEntry, readonly SelectionTurn[]>();
  if (orphanedMembers.length > 0) {
    type ElderCandidate = { turn: SelectionTurn } | { run: SelectionTurn[] };
    const candidates: ElderCandidate[] = [];
    for (const turn of orphanedMembers) {
      const last = candidates.at(-1);
      if (hasReadyTurnSummary(turn)) candidates.push({ turn });
      else if (last !== undefined && "run" in last) last.run.push(turn);
      else candidates.push({ run: [turn] });
    }
    const buildElder = (candidate: ElderCandidate, band: "detailed" | "brief"): ArrangementEntry => {
      if ("turn" in candidate) return buildCoverageEntry(candidate.turn, band);
      const ascending = [...candidate.run].reverse();
      const entry = gapMarkerEntry(ascending, band);
      markerMembers.set(entry, ascending);
      return entry;
    };
    const detailedTurns = fillBand(
      candidates,
      detailedBudget,
      (candidate) => buildElder(candidate, "detailed"),
      "stop",
      !cascading,
      detailed.included,
    );
    const briefTurns = fillBand(
      detailedTurns.rest,
      briefBudget,
      (candidate) => buildElder(candidate, "brief"),
      "skip",
      !cascading,
      brief.included,
    );
    detailed.included.push(...detailedTurns.included);
    brief.included.push(...briefTurns.included);
    brief.skipped.push(...briefTurns.skipped.filter((entry) => !markerMembers.has(entry)));
    for (const entry of [...detailedTurns.included, ...briefTurns.included]) {
      const turn = markerMembers.has(entry) ? undefined : turnsById.get(entry.subjectId);
      if (turn !== undefined) oldestSelectedTurnOrder = Math.min(oldestSelectedTurnOrder, turn.turnOrder);
    }
  }

  function gapMarkerEntry(turnsInRun: readonly SelectionTurn[], band: ArrangementEntry["band"]): ArrangementEntry {
    const first = turnsInRun[0] as SelectionTurn;
    const last = turnsInRun[turnsInRun.length - 1] as SelectionTurn;
    const label = first === last ? `turn ${first.turnId}` : `turns ${first.turnId}–${last.turnId}`;
    const reason = `${label} not in view; use get-turns`;
    const text = `[${reason}]`;
    return {
      band,
      subjectKind: "turn",
      subjectId: first === last ? first.turnId : `${first.turnId}–${last.turnId}`,
      derivationUsed: "gap",
      degraded: false,
      gap: true,
      reason,
      startOrder: turnStartOrder(first),
      text,
      tokens: estimator.estimate(text),
    };
  }

  function readyContent(derivation: DerivationSnapshot | undefined): string | null {
    return derivation?.state === "ready" && typeof derivation.content === "string" ? derivation.content : null;
  }

  function derivationState(derivation: DerivationSnapshot | undefined): string {
    return derivation === undefined ? "missing" : derivation.state;
  }

  function buildCoverageEntry(turn: SelectionTurn, band: "detailed" | "brief" = "detailed"): ArrangementEntry {
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
      band,
      subjectKind: "turn",
      subjectId: turn.turnId,
      derivationUsed: rep.derivationUsed,
      degraded: rep.degraded,
      gap: rep.gap,
      startOrder: turnStartOrder(turn),
      text,
      tokens: estimator.estimate(text),
    };
    if (rep.reason !== undefined) entry.reason = rep.reason;
    return entry;
  }

  const coverageGaps = bandedTurns
    .filter(
      (turn) =>
        turn.turnOrder >= oldestSelectedTurnOrder &&
        !coveredTurnIds.has(turn.turnId) &&
        !settledElderTurnIds.has(turn.turnId),
    )
    .map((turn) => buildCoverageEntry(turn));

  let entries: ArrangementEntry[] = [
    ...brief.included.sort(byRecordOrder),
    ...[...detailed.included, ...coverageGaps].sort(byRecordOrder),
    ...smooth.included.sort(byRecordOrder),
  ];

  const materialEntries = entries.filter((entry) => !markerMembers.has(entry));
  const coveredFrom =
    materialEntries.length === 0 ? compactPoint : Math.min(...materialEntries.map((entry) => entry.startOrder));

  const representedTurnIds = new Set<string>();
  for (const entry of entries) {
    const members = markerMembers.get(entry);
    if (members !== undefined) for (const turn of members) representedTurnIds.add(turn.turnId);
    else if (entry.subjectKind === "turn") representedTurnIds.add(entry.subjectId);
    else for (const turnId of chunksById.get(entry.subjectId)?.memberTurnIds ?? []) representedTurnIds.add(turnId);
  }
  const unrepresentedRuns: SelectionTurn[][] = [];
  let run: SelectionTurn[] = [];
  for (const turn of bandedTurns) {
    if (!representedTurnIds.has(turn.turnId)) {
      run.push(turn);
      continue;
    }
    if (run.length > 0) unrepresentedRuns.push(run);
    run = [];
  }
  if (run.length > 0) unrepresentedRuns.push(run);
  if (unrepresentedRuns.length > 0) {
    const markers = unrepresentedRuns.map((turnsInRun): ArrangementEntry => {
      const startOrder = turnStartOrder(turnsInRun[0] as SelectionTurn);
      const olderNeighbor = entries
        .filter((entry) => entry.startOrder < startOrder)
        .reduce<ArrangementEntry | undefined>(
          (newest, entry) => (newest === undefined || entry.startOrder > newest.startOrder ? entry : newest),
          undefined,
        );
      return gapMarkerEntry(turnsInRun, olderNeighbor?.band ?? "brief");
    });
    const withMarkers = [...entries, ...markers];
    entries = (["brief", "detailed", "smooth"] as const).flatMap((band) =>
      withMarkers.filter((entry) => entry.band === band).sort(byRecordOrder),
    );
  }

  const skipped: SkippedSubject[] = brief.skipped.map((entry) => ({
    band: entry.band,
    subjectId: entry.subjectId,
    tokens: entry.tokens,
    reason: `entry did not fit the remaining ${entry.band} budget (${entry.tokens} tokens from ${entry.derivationUsed}); skipped so older entries could be selected`,
  }));

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
