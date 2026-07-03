// The turns derivation handlers: turn_derivation (deterministic assembly),
// detailed_turn_compression (inference over pre_detailed_assembly), and the
// two chunk summaries. turn_derivation composes turn_rendering and
// pre_detailed_assembly, places the turn from uncompressed assembly tokens,
// and enqueues detailed_turn_compression in the same completion transaction.

import type { DatabaseSync } from "node:sqlite";
import { writeMessageDerivationFloorInThread } from "../../messages/internal/derive.js";
import type {
  DerivationMetadata,
  ErrorResult,
  HandlerOutcome,
  HandlerRunContext,
  RenderingPart,
  ResolvedSdkConfig,
  WorkHandler,
} from "../../shared-tech/index.js";
import {
  applyDerivationSuccess,
  applyDerivationTerminalFailure,
  createPostCommitHookSet,
  DerivationCompletionError,
  type DurableWorkDispatchResult,
  resolveInstancePoke,
  runWorkHandler,
} from "../../shared-tech/index.js";
import { appendDerivationLog, type LogEntry, writeLog } from "../../shared-tech/logging/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import {
  createOrClaimImmediateWorkItem,
  type EnqueueDerivationTarget,
  enqueue,
  hasLiveItem,
  type ImmediateDerivationBoundary,
  retryClaimedItem,
  type WorkKind,
  type WorkSourceRef,
} from "../../shared-tech/work-queue/index.js";
import { enqueueChunkSummaries, placeTurn } from "./chunks.js";
import { composePreDetailedAssembly, composeRenderingInput } from "./compose.js";
import {
  chunkExists,
  readChunkSummaryDerivation,
  readMemberMessages,
  readMemberProjections,
  readMessageDerivationRows,
  readTurnDerivationRow,
  readTurnSource,
} from "./derivations.js";
import { selectOpenTurnIds } from "./store.js";

function sourceDamaged(reason: string): Extract<HandlerOutcome, { ok: false }> {
  return { ok: false, blocked: true, reason: `source_damaged: ${reason}` };
}

function inferenceFailed(result: { retryable: boolean; reason: string }): Extract<HandlerOutcome, { ok: false }> {
  return { ok: false, retryable: result.retryable, reason: result.reason };
}

function dependencyNotReady(reason: string): Extract<HandlerOutcome, { ok: false }> {
  return { ok: false, retryable: true, reason };
}

function renderingPartLabel(kind: RenderingPart["kind"]): string {
  switch (kind) {
    case "user_prompt":
      return "User prompt";
    case "assistant_text":
      return "Assistant response";
    case "assistant_thinking":
      return "Assistant thinking";
    case "runtime_note":
      return "Runtime note";
    case "model_change":
      return "Model change";
    case "thinking_level_change":
      return "Thinking level change";
    case "tool_call":
      return "Tool call";
    case "tool_result":
      return "Tool result";
  }
}

function composeStructuredTurnText(parts: readonly RenderingPart[]): string {
  return parts
    .map((part, index) => {
      const annotations = [
        part.fallback ? "fallback" : undefined,
        part.outcome === undefined ? undefined : `outcome: ${part.outcome}`,
      ].filter((annotation): annotation is string => annotation !== undefined);
      const suffix = annotations.length === 0 ? "" : ` [${annotations.join("; ")}]`;
      return `[${index + 1}] ${renderingPartLabel(part.kind)} (${part.messageId})${suffix}\n${part.text}`;
    })
    .join("\n\n");
}

function composeDetailedChunkSummary(memberProjections: readonly string[]): string {
  return memberProjections
    .map((memberText, index) => {
      return [`[turn ${String(index + 1).padStart(4, "0")}]`, memberText].join("\n");
    })
    .join("\n\n");
}

function compressionTargetTokens(
  inputTokens: number,
  targets: ResolvedSdkConfig["compressionTargets"] | ResolvedSdkConfig["briefTargets"],
): {
  inputTokens: number;
  targetMinTokens: number;
  targetAimTokens: number;
  targetMaxTokens: number;
} {
  return {
    inputTokens,
    targetMinTokens: Math.max(1, Math.round(inputTokens * targets.minRatio)),
    targetAimTokens: Math.max(1, Math.round(inputTokens * targets.aimRatio)),
    targetMaxTokens: Math.max(1, Math.round(inputTokens * targets.maxRatio)),
  };
}

function sizeDisposition(
  outputTokens: number,
  targets: { targetMinTokens: number; targetMaxTokens: number },
): NonNullable<DerivationMetadata["sizeDisposition"]> {
  if (outputTokens < targets.targetMinTokens) return "under_min";
  if (outputTokens > targets.targetMaxTokens) return "over_max";
  return "in_range";
}

function pokeThreadScheduler(db: DatabaseSync): void {
  const row = db.prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`).get() as
    | { thread_id: string }
    | undefined;
  if (row !== undefined) resolveInstancePoke()(row.thread_id);
}

function logFallback(
  run: HandlerRunContext,
  entry: {
    derivationType: string;
    subjectId: string;
    reason: "not_ready" | "failed_floor";
    floorUsed: string;
  },
): void {
  const db = run.openDb();
  writeLog(
    {
      db,
      threadId: run.threadId,
      filePath: run.filePath,
    },
    {
      level: "warning",
      message: "derivation fallback used",
      derivationType: entry.derivationType,
      subjectId: entry.subjectId,
      reason: entry.reason,
      floorUsed: entry.floorUsed,
    },
  );
}

function readClaimedWorkAttempts(db: DatabaseSync, workItemId: string): number {
  const row = db
    .prepare(`SELECT attempts FROM work_item WHERE work_item_id = ? AND status = 'claimed'`)
    .get(workItemId) as { attempts: number } | undefined;
  return row === undefined ? 0 : Number(row.attempts);
}

function compressionExhausted(
  compressionResult: { ok: false; retryable: boolean; reason: string },
  attempts: number,
  retryBudget: number,
): boolean {
  const nextAttempt = attempts + 1;
  return !compressionResult.retryable || nextAttempt >= retryBudget;
}

const turnDerivationHandler: WorkHandler = async (run, item) => {
  const turnId = item.sourceRef["turnId"];
  if (turnId === undefined) return sourceDamaged("work item carries no turnId");
  const db = run.openDb();
  const turn = readTurnSource(db, turnId);
  if (turn === undefined || turn.deleted) {
    return sourceDamaged(`turn ${turnId} not found`);
  }
  if (turn.status !== "closed") {
    return sourceDamaged(`turn ${turnId} is open under a derivation item`);
  }
  const openTurnIds = selectOpenTurnIds(db);
  if (openTurnIds.length > 1) {
    return sourceDamaged(`turn state corrupt: ${openTurnIds.length} turns open (${openTurnIds.join(", ")})`);
  }

  const messages = readMemberMessages(db, turnId);
  const derivations = readMessageDerivationRows(
    db,
    messages.map((message) => message.messageId),
  );
  const { parts, recoveries } = composeRenderingInput(messages, derivations);
  const assembly = composePreDetailedAssembly(messages, derivations);
  const seenRecoveries = new Set<string>();
  const mergedRecoveries = [...recoveries, ...assembly.recoveries].filter((recovery) => {
    const key = `${recovery.subjectId}:${recovery.derivationType}`;
    if (seenRecoveries.has(key)) return false;
    seenRecoveries.add(key);
    return true;
  });
  for (const recovery of mergedRecoveries) {
    logFallback(run, {
      derivationType: recovery.derivationType,
      subjectId: recovery.subjectId,
      reason: recovery.reason,
      floorUsed: recovery.floorUsed,
    });
    writeMessageDerivationFloorInThread(run, {
      messageId: recovery.subjectId,
      derivationType: recovery.derivationType as "smoothed_prompt" | "tool_result_summary",
      content: recovery.content,
      sourceVersion: recovery.sourceVersion,
    });
  }

  const renderingText = composeStructuredTurnText(parts);
  const assemblyText = assembly.text;
  const projectedTokens = estimateTokens(assemblyText);
  const threadId = run.threadId;
  const compressionSourceVersion =
    readTurnDerivationRow(db, "turn", turnId, "pre_detailed_assembly")?.sourceVersion ?? 1;

  return {
    ok: true,
    derivations: [
      {
        subjectKind: "turn",
        subjectId: turnId,
        derivationType: "turn_rendering",
        content: renderingText,
      },
      {
        subjectKind: "turn",
        subjectId: turnId,
        derivationType: "pre_detailed_assembly",
        content: assemblyText,
      },
    ],
    onApplied: (transaction) => {
      if (!hasLiveItem(transaction.db, "detailed_turn_compression", { turnId }, compressionSourceVersion)) {
        enqueue(
          {
            db: transaction.db,
            clock: run.clock,
            threadId,
            filePath: run.filePath,
            postCommitHook: { add: transaction.onCommit },
            poke: resolveInstancePoke(),
          },
          {
            owner: "turns",
            kind: "detailed_turn_compression",
            sourceRef: { turnId },
            sourceVersion: compressionSourceVersion,
            derivations: [{ subjectKind: "turn", subjectId: turnId, derivationType: "detailed_turn_compression" }],
          },
        );
      }
      const placement = placeTurn(transaction.db, turnId, projectedTokens, run.config.chunkPolicy);
      for (const chunkId of placement.closedChunkIds) {
        enqueueChunkSummaries(
          {
            db: transaction.db,
            clock: run.clock,
            threadId,
            filePath: run.filePath,
            postCommitHook: { add: transaction.onCommit },
            poke: resolveInstancePoke(),
          },
          chunkId,
        );
      }
    },
  };
};

const detailedTurnCompressionHandler: WorkHandler = async (run, item) => {
  const turnId = item.sourceRef["turnId"];
  if (turnId === undefined) return sourceDamaged("work item carries no turnId");
  const db = run.openDb();
  const turn = readTurnSource(db, turnId);
  if (turn === undefined || turn.deleted) {
    return sourceDamaged(`turn ${turnId} not found`);
  }
  if (turn.status !== "closed") {
    return sourceDamaged(`turn ${turnId} is open under a derivation item`);
  }

  const assemblyRow = readTurnDerivationRow(db, "turn", turnId, "pre_detailed_assembly");
  if (assemblyRow === undefined || assemblyRow.state !== "ready" || assemblyRow.content === undefined) {
    return dependencyNotReady(
      `pre_detailed_assembly_not_ready: turn ${turnId} pre_detailed_assembly is ${assemblyRow?.state ?? "missing"}`,
    );
  }
  const assemblyText = assemblyRow.content;
  const inputTokens = estimateTokens(assemblyText);
  const tinyTurnTokens = run.config.guards.detailedTurnCompression.tinyTurnTokens;
  const targetTokens = compressionTargetTokens(inputTokens, run.config.compressionTargets);
  const compressionResult =
    inputTokens < tinyTurnTokens
      ? ({ ok: true, text: assemblyText } as const)
      : await run.inferenceCallbacks.compressDetailedTurn({ dialogueText: assemblyText, ...targetTokens });

  const claimAttempts = readClaimedWorkAttempts(db, item.workItemId);
  let compressionText = assemblyText;
  let compressionUsedFallback = false;
  let compressionFailureReason: string | undefined;
  if (!compressionResult.ok) {
    appendDerivationLog(
      { db, threadId: run.threadId, filePath: run.filePath },
      {
        target: {
          subjectKind: "turn",
          subjectId: turnId,
          derivationType: "detailed_turn_compression",
        },
        eventKind: "inference_failed",
        payload: {
          reason: compressionResult.reason,
          attempts: claimAttempts + 1,
          ...(compressionResult.requestMessages !== undefined
            ? { requestMessages: compressionResult.requestMessages }
            : {}),
        },
      },
    );
    if (!compressionExhausted(compressionResult, claimAttempts, run.config.retry.budget)) {
      return inferenceFailed(compressionResult);
    }
    compressionUsedFallback = true;
    compressionFailureReason = compressionResult.reason;
  } else {
    compressionText = compressionResult.text;
    if (inputTokens >= tinyTurnTokens) {
      appendDerivationLog(
        { db, threadId: run.threadId, filePath: run.filePath },
        {
          target: {
            subjectKind: "turn",
            subjectId: turnId,
            derivationType: "detailed_turn_compression",
          },
          eventKind: "inference_succeeded",
          payload: {
            ...("provenance" in compressionResult && compressionResult.provenance !== undefined
              ? { provenance: compressionResult.provenance }
              : {}),
            ...("requestMessages" in compressionResult && compressionResult.requestMessages !== undefined
              ? { requestMessages: compressionResult.requestMessages }
              : {}),
            ...("rawResponse" in compressionResult && compressionResult.rawResponse !== undefined
              ? { rawResponse: compressionResult.rawResponse }
              : {}),
          },
        },
      );
    }
  }

  const projectedTokens = estimateTokens(compressionText);
  const compressionMetadata: DerivationMetadata = {};
  if (!compressionUsedFallback && "provenance" in compressionResult && compressionResult.provenance !== undefined) {
    compressionMetadata.provenance = compressionResult.provenance;
  }
  if (compressionUsedFallback) {
    compressionMetadata.attempts = claimAttempts + 1;
    compressionMetadata.inferenceAttempted = true;
    compressionMetadata.inferenceSucceeded = false;
    compressionMetadata.fallbackUsed = true;
    if (compressionFailureReason !== undefined) {
      compressionMetadata.lastError = compressionFailureReason;
    }
    compressionMetadata.fallbackFloor = "pre_detailed_assembly";
  } else if (inputTokens >= tinyTurnTokens) {
    compressionMetadata.inferenceAttempted = true;
    compressionMetadata.inferenceSucceeded = true;
    compressionMetadata.sizeDisposition = sizeDisposition(projectedTokens, targetTokens);
  }

  return {
    ok: true,
    derivations: [
      {
        subjectKind: "turn",
        subjectId: turnId,
        derivationType: "detailed_turn_compression",
        content: compressionText,
        ...(Object.keys(compressionMetadata).length > 0 ? { metadata: compressionMetadata } : {}),
      },
    ],
    ...(compressionUsedFallback
      ? {
          onApplied: (transaction) => {
            appendDerivationLog(
              {
                db: transaction.db,
                threadId: run.threadId,
                filePath: run.filePath,
                postCommitHook: { add: transaction.onCommit },
              },
              {
                target: {
                  subjectKind: "turn",
                  subjectId: turnId,
                  derivationType: "detailed_turn_compression",
                },
                eventKind: "fallback_applied",
                payload: {
                  fallbackFloor: "pre_detailed_assembly",
                  ...(compressionFailureReason !== undefined ? { reason: compressionFailureReason } : {}),
                  attempts: claimAttempts + 1,
                },
              },
            );
            writeLog(
              {
                db: transaction.db,
                threadId: run.threadId,
                filePath: run.filePath,
                postCommitHook: { add: transaction.onCommit },
              },
              {
                level: "warning",
                message: "turn compression fallback used",
                derivationType: "detailed_turn_compression",
                subjectId: turnId,
                ...(compressionFailureReason !== undefined ? { reason: compressionFailureReason } : {}),
                floorUsed: "pre_detailed_assembly",
              },
            );
          },
        }
      : {}),
  };
};

// Detailed is deterministic material assembly from stored member compressions.
// Brief is inference-backed and consumes the stored detailed summary for the
// same chunk.
type DetailedChunkComposition =
  | Extract<HandlerOutcome, { ok: false }>
  | { ok: true; text: string; fallbackLogs: LogEntry[] };

function composeDetailedChunkFromMembers(db: DatabaseSync, chunkId: string): DetailedChunkComposition {
  const members = readMemberProjections(db, chunkId);
  const memberProjections: string[] = [];
  const fallbackLogs: LogEntry[] = [];
  for (const member of members) {
    if (member.sourceCorruptionReason !== undefined) {
      return sourceDamaged(member.sourceCorruptionReason);
    }
    if (member.state === "ready" && member.content !== undefined) {
      memberProjections.push(member.content);
      continue;
    }
    if (member.state === "blocked") {
      return sourceDamaged(
        `member ${member.turnId} detailed_turn_compression blocked while deriving chunk_summary_detailed`,
      );
    }
    if (member.state === "failed" && member.assemblyState === "ready" && member.assemblyContent !== undefined) {
      memberProjections.push(member.assemblyContent);
      fallbackLogs.push({
        level: "warning",
        message: "derivation fallback used",
        derivationType: "chunk_summary_detailed",
        subjectId: chunkId,
        reason: "failed_floor",
        floorUsed: member.turnId,
      });
      continue;
    }
    return dependencyNotReady(
      `member_projection_not_ready: member ${member.turnId} detailed_turn_compression is ${member.state ?? "missing"}`,
    );
  }
  return {
    ok: true,
    text: composeDetailedChunkSummary(memberProjections),
    fallbackLogs,
  };
}

function chunkDetailedHandler(): WorkHandler {
  return async (run, item) => {
    const chunkId = item.sourceRef["chunkId"];
    if (chunkId === undefined) return sourceDamaged("work item carries no chunkId");
    const db = run.openDb();
    if (!chunkExists(db, chunkId)) return sourceDamaged(`chunk ${chunkId} not found`);
    const composition = composeDetailedChunkFromMembers(db, chunkId);
    if (!composition.ok) return composition;

    return {
      ok: true,
      derivations: [
        {
          subjectKind: "chunk",
          subjectId: chunkId,
          derivationType: "chunk_summary_detailed",
          content: composition.text,
        },
      ],
      ...(composition.fallbackLogs.length === 0
        ? {}
        : {
            onApplied: (transaction) => {
              const logTransaction = {
                db: transaction.db,
                clock: run.clock,
                threadId: run.threadId,
                filePath: run.filePath,
                postCommitHook: { add: transaction.onCommit },
                poke: resolveInstancePoke(),
              };
              for (const entry of composition.fallbackLogs) writeLog(logTransaction, entry);
            },
          }),
    };
  };
}

function chunkBriefHandler(): WorkHandler {
  return async (run, item) => {
    const chunkId = item.sourceRef["chunkId"];
    if (chunkId === undefined) return sourceDamaged("work item carries no chunkId");
    const db = run.openDb();
    if (!chunkExists(db, chunkId)) return sourceDamaged(`chunk ${chunkId} not found`);

    const detailed = readChunkSummaryDerivation(db, chunkId, "chunk_summary_detailed");
    const brief = readChunkSummaryDerivation(db, chunkId, "chunk_summary_brief");
    if (detailed === undefined || detailed.state === "pending") {
      const sourceVersion = detailed?.sourceVersion ?? brief?.sourceVersion;
      if (sourceVersion === undefined) {
        return sourceDamaged(`chunk ${chunkId} has no chunk_summary_detailed or chunk_summary_brief derivation row`);
      }
      return {
        ok: false,
        deferred: true,
        reason: `chunk_summary_detailed_not_ready: chunk ${chunkId} chunk_summary_detailed is ${detailed?.state ?? "missing"}`,
        onDeferred: (transaction) => {
          const threadId = run.threadId;
          if (!hasLiveItem(transaction.db, "chunk_summary_detailed", { chunkId }, sourceVersion)) {
            enqueue(
              {
                db: transaction.db,
                clock: run.clock,
                threadId,
                filePath: run.filePath,
                postCommitHook: { add: transaction.onCommit },
                poke: resolveInstancePoke(),
              },
              {
                owner: "turns",
                kind: "chunk_summary_detailed",
                sourceRef: { chunkId },
                sourceVersion,
                derivations: [{ subjectKind: "chunk", subjectId: chunkId, derivationType: "chunk_summary_detailed" }],
              },
            );
          }
          enqueue(
            {
              db: transaction.db,
              clock: run.clock,
              threadId,
              filePath: run.filePath,
              postCommitHook: { add: transaction.onCommit },
              poke: resolveInstancePoke(),
            },
            {
              owner: "turns",
              kind: "chunk_summary_brief",
              sourceRef: { chunkId },
              sourceVersion,
              derivations: [{ subjectKind: "chunk", subjectId: chunkId, derivationType: "chunk_summary_brief" }],
            },
          );
        },
      };
    }
    if (detailed.state === "blocked" || detailed.state === "failed") {
      return sourceDamaged(
        `chunk ${chunkId} chunk_summary_detailed is ${detailed.state}: ${detailed.reason ?? "no reason"}`,
      );
    }
    if (detailed.content === undefined) {
      return dependencyNotReady(`chunk_summary_detailed_not_ready: chunk ${chunkId} has no detailed content`);
    }

    const targetTokens = compressionTargetTokens(estimateTokens(detailed.content), run.config.briefTargets);
    const result = await run.inferenceCallbacks.summarizeChunkBrief({ text: detailed.content, ...targetTokens });
    if (!result.ok) {
      appendDerivationLog(
        { db, threadId: run.threadId, filePath: run.filePath },
        {
          target: {
            subjectKind: "chunk",
            subjectId: chunkId,
            derivationType: "chunk_summary_brief",
          },
          eventKind: "inference_failed",
          payload: {
            reason: result.reason,
            ...(result.requestMessages !== undefined ? { requestMessages: result.requestMessages } : {}),
          },
        },
      );
      return inferenceFailed(result);
    }
    appendDerivationLog(
      { db, threadId: run.threadId, filePath: run.filePath },
      {
        target: {
          subjectKind: "chunk",
          subjectId: chunkId,
          derivationType: "chunk_summary_brief",
        },
        eventKind: "inference_succeeded",
        payload: {
          ...(result.provenance !== undefined ? { provenance: result.provenance } : {}),
          ...(result.requestMessages !== undefined ? { requestMessages: result.requestMessages } : {}),
          ...(result.rawResponse !== undefined ? { rawResponse: result.rawResponse } : {}),
        },
      },
    );
    const outputTokens = estimateTokens(result.text);
    const metadata: DerivationMetadata = {
      inferenceAttempted: true,
      inferenceSucceeded: true,
      sizeDisposition: sizeDisposition(outputTokens, targetTokens),
    };
    if (result.provenance !== undefined) metadata.provenance = result.provenance;

    return {
      ok: true,
      derivations: [
        {
          subjectKind: "chunk",
          subjectId: chunkId,
          derivationType: "chunk_summary_brief",
          content: result.text,
          metadata,
        },
      ],
    };
  };
}

// The domain's handler table, merged into the SDK dispatch map at construction.
export const turnWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> = {
  turn_derivation: turnDerivationHandler,
  detailed_turn_compression: detailedTurnCompressionHandler,
  chunk_summary_detailed: chunkDetailedHandler(),
  chunk_summary_brief: chunkBriefHandler(),
};

function deferClaimedTurnWork(
  db: DatabaseSync,
  item: { workItemId: string; claimEpoch: number },
  onDeferred: (transaction: { db: DatabaseSync; onCommit: (fn: () => void) => void }) => void,
): boolean {
  const postCommitHook = createPostCommitHookSet();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const owned = db
      .prepare(`SELECT 1 FROM work_item WHERE work_item_id = ? AND status = 'claimed' AND claim_epoch = ?`)
      .get(item.workItemId, item.claimEpoch);
    if (owned === undefined) {
      db.exec("COMMIT;");
      return false;
    }
    db.prepare(`DELETE FROM work_item WHERE work_item_id = ? AND status = 'claimed' AND claim_epoch = ?`).run(
      item.workItemId,
      item.claimEpoch,
    );
    onDeferred({ db, onCommit: postCommitHook.add });
    db.exec("COMMIT;");
    postCommitHook.flush();
    return true;
  } catch (cause) {
    db.exec("ROLLBACK;");
    throw cause;
  }
}

function sourceVersionForDerive(rows: readonly { state: string; sourceVersion: number }[]): number {
  const versions = rows.map((row) => row.sourceVersion);
  const max = Math.max(...versions);
  return rows.some((row) => row.state === "pending") ? max : max + 1;
}

function failed(error: ErrorResult): { outcome: "failed"; error: ErrorResult } {
  return { outcome: "failed", error };
}

function sourceRefId(sourceRef: WorkSourceRef): string {
  if ("turnId" in sourceRef) return sourceRef.turnId;
  if ("chunkId" in sourceRef) return sourceRef.chunkId;
  return sourceRef.messageId;
}

function workInFlight(
  kind: WorkKind,
  sourceRef: WorkSourceRef,
  sourceVersion: number,
): { outcome: "failed"; error: ErrorResult } {
  const sourceId = sourceRefId(sourceRef);
  return failed({
    errorClass: "caller_error",
    code: "derivation_work_in_flight",
    reason: `${kind} work for ${sourceId} at sourceVersion ${sourceVersion} is already live`,
  });
}

function retryScheduled(reason: string): { outcome: "failed"; error: ErrorResult } {
  return failed({
    errorClass: "system_error",
    code: "derivation_retry_scheduled",
    reason,
  });
}

export async function deriveTurnOwnedInOpenDb(
  db: DatabaseSync,
  config: ResolvedSdkConfig,
  kind: WorkKind,
  sourceRef: WorkSourceRef,
  derivations: readonly EnqueueDerivationTarget[],
  opts?: { sourceVersion?: number },
): Promise<{ outcome: "derived"; sourceVersion: number } | { outcome: "failed"; error: ErrorResult }> {
  const rows = derivations.map((target) =>
    readTurnDerivationRow(db, target.subjectKind as "turn" | "chunk", target.subjectId, target.derivationType),
  );
  if (rows.some((row) => row === undefined)) {
    const target = derivations.find((_entry, index) => rows[index] === undefined)!;
    return failed({
      errorClass: "caller_error",
      code: "turn_not_found",
      reason: `no derived derivation ${target.derivationType} exists for ${target.subjectKind} ${target.subjectId}`,
    });
  }
  const blocked = rows.find((row) => row?.state === "blocked");
  if (blocked !== undefined) {
    return failed({
      errorClass: "state_corruption",
      code: "source_damaged",
      reason: blocked.reason ?? `turn-owned derivation is blocked`,
    });
  }
  const sourceVersion =
    opts?.sourceVersion ?? sourceVersionForDerive(rows as Array<{ state: string; sourceVersion: number }>);
  const expectedDerivations: ImmediateDerivationBoundary[] = derivations.map((target, index) => {
    const row = rows[index];
    if (row === undefined) {
      throw new Error(`missing checked derivation row for ${target.subjectKind} ${target.subjectId}`);
    }
    return { ...target, exists: true, state: row.state, sourceVersion: row.sourceVersion };
  });
  const handler = turnWorkHandlers[kind];
  if (handler === undefined) {
    return failed({
      errorClass: "state_corruption",
      code: "unknown_work_kind",
      reason: `no handler registered for work kind "${kind}"`,
    });
  }
  const claim = createOrClaimImmediateWorkItem(
    db,
    {
      owner: "turns",
      kind,
      sourceRef,
      sourceVersion,
      derivations,
      expectedDerivations,
    },
    { now: config.clock().toISOString(), leaseDurationMs: config.lease.durationMs },
  );
  if (claim.outcome !== "claimed") {
    if (claim.outcome === "queued") pokeThreadScheduler(db);
    return workInFlight(kind, sourceRef, sourceVersion);
  }
  const outcome = await runWorkHandler(db, config, handler, {
    workItemId: claim.item.workItemId,
    kind,
    sourceRef,
  });
  const attempt = {
    sourceVersion,
    derivations,
    workItemId: claim.item.workItemId,
    claimEpoch: claim.item.claimEpoch,
  };
  if (outcome.ok) {
    try {
      const disposition = applyDerivationSuccess(
        db,
        attempt,
        outcome.derivations ?? [],
        config.clock().toISOString(),
        outcome.onApplied,
      );
      if (disposition !== "done") {
        return workInFlight(kind, sourceRef, sourceVersion);
      }
    } catch (cause) {
      if (cause instanceof DerivationCompletionError) {
        return failed({
          errorClass: cause.errorClass,
          code: cause.code,
          reason: cause.message,
        });
      }
      throw cause;
    }
    return { outcome: "derived", sourceVersion };
  }
  if ("deferred" in outcome) {
    const deferred = deferClaimedTurnWork(
      db,
      { workItemId: claim.item.workItemId, claimEpoch: claim.item.claimEpoch },
      outcome.onDeferred,
    );
    if (!deferred) return workInFlight(kind, sourceRef, sourceVersion);
    pokeThreadScheduler(db);
    return retryScheduled(outcome.reason);
  }
  const attempts = claim.item.attempts + 1;
  const now = config.clock().toISOString();
  if (!("blocked" in outcome) && outcome.retryable && attempts < config.retry.budget) {
    const backoffMs = Math.min(config.retry.backoffBaseMs * 2 ** attempts, config.retry.backoffCapMs);
    const eligibleAt = new Date(Date.parse(now) + backoffMs).toISOString();
    const owned = retryClaimedItem(db, claim.item, { reason: outcome.reason, attempts, eligibleAt });
    if (!owned) return workInFlight(kind, sourceRef, sourceVersion);
    pokeThreadScheduler(db);
    return retryScheduled(outcome.reason);
  }
  try {
    const disposition = applyDerivationTerminalFailure(db, attempt, {
      reason: outcome.reason,
      state: "blocked" in outcome ? "blocked" : "failed",
      attempts,
      now,
    });
    if (disposition === "lost_lease") {
      return workInFlight(kind, sourceRef, sourceVersion);
    }
  } catch (cause) {
    if (cause instanceof DerivationCompletionError) {
      return failed({
        errorClass: cause.errorClass,
        code: cause.code,
        reason: cause.message,
      });
    }
    throw cause;
  }
  return failed({
    errorClass: "system_error",
    code: "provider_failure",
    reason: outcome.reason,
  });
}

export async function dispatchTurnOwnedWork(
  run: HandlerRunContext,
  item: {
    workItemId: string;
    claimEpoch: number;
    kind: WorkKind;
    sourceRef: WorkSourceRef;
    sourceVersion: number;
    derivations: readonly EnqueueDerivationTarget[];
  },
): Promise<DurableWorkDispatchResult> {
  const db = run.openDb();
  const handler = turnWorkHandlers[item.kind];
  if (handler === undefined) return { disposition: "failed", retryable: false, reason: "unknown_work_kind" };
  const outcome = await runWorkHandler(
    db,
    run.config,
    handler,
    {
      workItemId: item.workItemId,
      kind: item.kind,
      sourceRef: item.sourceRef,
    },
    run,
  );
  if (outcome.ok) {
    const disposition = applyDerivationSuccess(
      db,
      {
        sourceVersion: item.sourceVersion,
        derivations: item.derivations,
        workItemId: item.workItemId,
        claimEpoch: item.claimEpoch,
      },
      outcome.derivations ?? [],
      run.config.clock().toISOString(),
      outcome.onApplied,
    );
    return { disposition };
  }
  if ("deferred" in outcome) {
    const deferred = deferClaimedTurnWork(db, item, outcome.onDeferred);
    return deferred ? { disposition: "done" } : { disposition: "lost_lease" };
  }
  if ("blocked" in outcome) return { disposition: "blocked", reason: outcome.reason };
  return { disposition: "failed", retryable: outcome.retryable, reason: outcome.reason };
}
