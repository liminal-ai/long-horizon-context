// The turns derivation handlers (Flow 3): turn_derivation — the epic's
// biggest single handler — and the two chunk summaries. turn_derivation
// composes the rendering from message-level derivations (compose.ts), sends the
// deterministic rendering through compressSmoothTurn, hands both derivations back
// for the version-checked completion write, and runs placement in that same
// completion transaction via the onApplied hook: open-chunk append, the
// accumulated close policy, and any close's summary enqueues all ride the
// one commit (anti-shim: a crash leaves either a placed turn with queued
// summaries or an open chunk — nothing between).

import type { DatabaseSync } from "node:sqlite";
import { deriveSmoothedPrompt, deriveToolResultSummary, findPairedToolCall } from "../../messages/recovery.js";
import type {
  DerivationMetadata,
  ErrorResult,
  HandlerOutcome,
  HandlerRunContext,
  InferenceResult,
  RenderingPart,
  ResolvedSdkConfig,
  ToolOutcome,
  ToolRunReceipt,
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
import { type LogEntry, writeLog } from "../../shared-tech/logging/index.js";
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
import {
  type ComposeDerivationRow,
  type ComposeMessage,
  composeDerivationKey,
  composeRenderingInput,
} from "./compose.js";
import {
  chunkExists,
  readChunkSummaryDerivation,
  readMemberMessages,
  readMemberProjections,
  readMessageDerivationRows,
  readTurnDerivationRow,
  readTurnSource,
} from "./derivations.js";
import { hasLiveRecoveryWork, recoverDerivation } from "./recovery.js";
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

function composeTurnRenderingText(parts: readonly RenderingPart[]): string {
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

function detailedReceiptBlock(receipts: readonly ToolRunReceipt[]): string {
  if (receipts.length === 0) return "";
  return `[receipts ${receipts.map((r) => `${r.account}=>${r.outcome}`).join("; ")}]`;
}

function composeDetailedChunkSummary(
  memberProjections: readonly string[],
  memberReceipts: readonly (readonly ToolRunReceipt[])[],
): string {
  return memberProjections
    .map((projection, index) => {
      const receiptBlock = detailedReceiptBlock(memberReceipts[index] ?? []);
      const section = [`[turn ${String(index + 1).padStart(4, "0")}]`, projection];
      if (receiptBlock !== "") section.push(receiptBlock);
      return section.join("\n");
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

function readThreadIdFromDb(db: DatabaseSync): string {
  const row = db.prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`).get() as
    | { thread_id: string }
    | undefined;
  return row?.thread_id ?? "";
}

function readThreadId(run: HandlerRunContext): string {
  return readThreadIdFromDb(run.openDb());
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
      threadId: readThreadId(run),
      filePath: "",
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

function toolOutcomeFromMessage(message: ComposeMessage): ToolOutcome {
  const block = message.blocks[0]?.content ?? {};
  return block["isError"] === true ? "failed" : "succeeded";
}

function pairedToolCall(
  run: HandlerRunContext,
  messages: readonly ComposeMessage[],
  toolCallId: unknown,
): { toolName: string; toolInput?: Record<string, unknown> } {
  if (typeof toolCallId !== "string") return { toolName: "unknown_tool" };
  const sameTurnCall = messages.find((message) => {
    if (message.kind !== "tool_call") return false;
    return message.blocks[0]?.content["toolCallId"] === toolCallId;
  });
  const sameTurnToolName = sameTurnCall?.blocks[0]?.content["toolName"];
  const sameTurnToolInput = sameTurnCall?.blocks[0]?.content["arguments"];
  if (typeof sameTurnToolName === "string") {
    return {
      toolName: sameTurnToolName,
      ...(sameTurnToolInput !== null && typeof sameTurnToolInput === "object" && !Array.isArray(sameTurnToolInput)
        ? { toolInput: sameTurnToolInput as Record<string, unknown> }
        : {}),
    };
  }
  return findPairedToolCall(run.openDb(), toolCallId) ?? { toolName: "unknown_tool" };
}

async function recoverMessageDerivations(
  run: HandlerRunContext,
  messages: readonly ComposeMessage[],
  derivations: Map<string, ComposeDerivationRow>,
): Promise<void> {
  for (const message of messages) {
    const plan =
      message.kind === "user_prompt"
        ? { derivationType: "smoothed_prompt" as const }
        : message.kind === "tool_result"
          ? { derivationType: "tool_result_summary" as const }
          : undefined;
    if (plan === undefined) continue;
    const key = composeDerivationKey(message.messageId, plan.derivationType);
    const row = derivations.get(key);
    if (row === undefined || row.state === "ready") continue;
    const live = hasLiveRecoveryWork(run.openDb(), {
      subjectKind: "message",
      subjectId: message.messageId,
      derivationType: plan.derivationType,
      sourceVersion: row.sourceVersion,
    });
    if (live) continue;

    const block = message.blocks[0]?.content ?? {};
    const content = typeof block["content"] === "string" ? block["content"] : "";
    let result: InferenceResult;
    let promptMetadata: DerivationMetadata | undefined;
    let promptWarningLog: LogEntry | undefined;
    if (message.kind === "user_prompt") {
      const text = typeof block["text"] === "string" ? block["text"] : "";
      const derived = await deriveSmoothedPrompt(run, message.messageId, text);
      if ("write" in derived) {
        result = { ok: true, text: derived.write.content };
        promptMetadata = derived.write.metadata;
        promptWarningLog = derived.warningLog;
      } else {
        result = derived;
      }
    } else {
      const outcome = toolOutcomeFromMessage(message);
      const pairedCall = pairedToolCall(run, messages, block["toolCallId"]);
      const derived = await deriveToolResultSummary(run, message.messageId, {
        toolName: pairedCall.toolName,
        ...(pairedCall.toolInput === undefined ? {} : { toolInput: pairedCall.toolInput }),
        content,
        outcome,
      });
      if ("write" in derived) {
        result = { ok: true, text: derived.write.content };
        promptMetadata = derived.write.metadata;
      } else {
        result = derived;
      }
    }
    if (!result.ok) continue;

    const metadata: DerivationMetadata | undefined =
      message.kind === "tool_result"
        ? promptMetadata
        : result.provenance === undefined
          ? promptMetadata
          : { ...(promptMetadata ?? {}), provenance: result.provenance };
    const recovered: ComposeDerivationRow = {
      state: "ready",
      content: result.text,
      sourceVersion: row.sourceVersion,
      ...(metadata === undefined ? {} : { metadata }),
    };
    derivations.set(key, recovered);
    const recovery = recoverDerivation(run.openDb(), {
      subjectKind: "message",
      subjectId: message.messageId,
      derivationType: plan.derivationType,
      content: result.text,
      ...(recovered.metadata === undefined ? {} : { metadata: recovered.metadata }),
      sourceVersion: row.sourceVersion,
      derivedAt: run.clock().toISOString(),
    });
    if (recovery.persisted && promptWarningLog !== undefined) {
      writeLog({ db: run.openDb(), threadId: readThreadId(run), filePath: "" }, promptWarningLog);
    }
  }
}

const turnDerivationHandler: WorkHandler = async (run, item) => {
  const turnId = item.sourceRef["turnId"];
  if (turnId === undefined) return sourceDamaged("work item carries no turnId");
  const db = run.openDb();
  const turn = readTurnSource(db, turnId);
  if (turn === undefined || turn.deleted) {
    // A deleted turn's derivation rows were dropped with it, so a blocked stamp
    // would hit nothing; either way the item is terminal against a source
    // that cannot improve.
    return sourceDamaged(`turn ${turnId} not found`);
  }
  if (turn.status !== "closed") {
    // Derivation is queued only at close; an open turn under a queued item
    // means the record was interfered with.
    return sourceDamaged(`turn ${turnId} is open under a derivation item`);
  }
  // Epic 01's corruption definition (AC-3.9 there, TC-4.6 here): only the
  // batch pipeline writes turn state and it never leaves two turns open, so
  // more than one open turn means the record was damaged below the SDK. A
  // handler must not compose against a membership it cannot trust; the derivation
  // lands blocked naming the damage, and later derive attempts refuse with
  // that reason until the source reads clean (Story 4).
  const openTurnIds = selectOpenTurnIds(db);
  if (openTurnIds.length > 1) {
    return sourceDamaged(`turn state corrupt: ${openTurnIds.length} turns open (${openTurnIds.join(", ")})`);
  }

  // Compose from current message-derivation states: ready derivations verbatim,
  // non-ready fall back with one gap each (AC-3.2). Pure — both reads land
  // before any inference call, and no transaction is held across them.
  const messages = readMemberMessages(db, turnId);
  const derivations = readMessageDerivationRows(
    db,
    messages.map((message) => message.messageId),
  );
  await recoverMessageDerivations(run, messages, derivations);
  const { parts, receipts, recoveries } = composeRenderingInput(messages, derivations);
  for (const recovery of recoveries) {
    logFallback(run, {
      derivationType: recovery.derivationType,
      subjectId: recovery.subjectId,
      reason: recovery.reason,
      floorUsed: recovery.floorUsed,
    });
    recoverDerivation(run.openDb(), {
      subjectKind: recovery.subjectKind,
      subjectId: recovery.subjectId,
      derivationType: recovery.derivationType,
      content: recovery.content,
      sourceVersion: recovery.sourceVersion,
      derivedAt: run.clock().toISOString(),
    });
  }

  const renderingText = composeTurnRenderingText(parts);
  const inputTokens = estimateTokens(renderingText);
  const tinyTurnTokens = run.config.guards.smoothTurnCompression.tinyTurnTokens;
  const targetTokens = compressionTargetTokens(inputTokens, run.config.compressionTargets);
  const projection =
    inputTokens < tinyTurnTokens
      ? ({ ok: true, text: renderingText } as const)
      : await run.inferenceCallbacks.compressSmoothTurn({ rendering: renderingText, ...targetTokens });
  if (!projection.ok) return inferenceFailed(projection);

  // The projection's token count is estimated exactly once, here, as the
  // artifact lands; placement reads this stored arithmetic and never
  // re-counts (AC-3.9's determinism input).
  const projectedTokens = estimateTokens(projection.text);
  const threadId = readThreadId(run);
  // Tool-run receipts ride the rendering's metadata, mechanically restated
  // from the composition input (AC-3.8) — the chunk summaries read them from
  // here, never from inference prose.
  const renderingMetadata: DerivationMetadata = {
    ...(receipts.length > 0 ? { receipts } : {}),
  };
  const compressionMetadata: DerivationMetadata = {};
  if ("provenance" in projection && projection.provenance !== undefined) {
    compressionMetadata.provenance = projection.provenance;
  }
  if (inputTokens >= tinyTurnTokens) {
    compressionMetadata.sizeDisposition = sizeDisposition(projectedTokens, targetTokens);
  }

  return {
    ok: true,
    derivations: [
      {
        subjectKind: "turn",
        subjectId: turnId,
        derivationType: "turn_rendering",
        content: renderingText,
        ...(Object.keys(renderingMetadata).length > 0 ? { metadata: renderingMetadata } : {}),
      },
      {
        subjectKind: "turn",
        subjectId: turnId,
        derivationType: "smooth_turn_compression",
        content: projection.text,
        ...(Object.keys(compressionMetadata).length > 0 ? { metadata: compressionMetadata } : {}),
      },
    ],
    onApplied: (transaction) => {
      const placement = placeTurn(transaction.db, turnId, projectedTokens, run.config.chunkPolicy);
      for (const chunkId of placement.closedChunkIds) {
        enqueueChunkSummaries(
          {
            db: transaction.db,
            clock: run.clock,
            threadId,
            filePath: "",
            postCommitHook: { add: transaction.onCommit },
            poke: resolveInstancePoke(),
          },
          chunkId,
        );
      }
    },
  };
};

// Detailed is deterministic material assembly from member projections plus
// per-turn tool-run receipts. Brief is inference-backed and consumes the stored
// detailed summary for the same chunk.
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
        `member ${member.turnId} smooth_turn_compression blocked while deriving chunk_summary_detailed`,
      );
    }
    if (member.state === "failed" && member.renderingState === "ready" && member.renderingContent !== undefined) {
      memberProjections.push(member.renderingContent);
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
      `member_projection_not_ready: member ${member.turnId} smooth_turn_compression is ${member.state ?? "missing"}`,
    );
  }
  return {
    ok: true,
    text: composeDetailedChunkSummary(
      memberProjections,
      members.map((member) => member.receipts),
    ),
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
                threadId: readThreadIdFromDb(transaction.db),
                filePath: "",
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
          const threadId = readThreadIdFromDb(transaction.db);
          if (!hasLiveItem(transaction.db, "chunk_summary_detailed", { chunkId }, sourceVersion)) {
            enqueue(
              {
                db: transaction.db,
                clock: run.clock,
                threadId,
                filePath: "",
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
              filePath: "",
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
    if (!result.ok) return inferenceFailed(result);
    const outputTokens = estimateTokens(result.text);
    const metadata: DerivationMetadata = { sizeDisposition: sizeDisposition(outputTokens, targetTokens) };
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

// The domain's handler table, merged into the SDK dispatch map at
// construction (DD-6).
export const turnWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> = {
  turn_derivation: turnDerivationHandler,
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
  db: DatabaseSync,
  config: ResolvedSdkConfig,
  item: {
    workItemId: string;
    claimEpoch: number;
    kind: WorkKind;
    sourceRef: WorkSourceRef;
    sourceVersion: number;
    derivations: readonly EnqueueDerivationTarget[];
  },
): Promise<DurableWorkDispatchResult> {
  const handler = turnWorkHandlers[item.kind];
  if (handler === undefined) return { disposition: "failed", retryable: false, reason: "unknown_work_kind" };
  const outcome = await runWorkHandler(db, config, handler, {
    workItemId: item.workItemId,
    kind: item.kind,
    sourceRef: item.sourceRef,
  });
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
      config.clock().toISOString(),
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
