// The turns derivation handlers (Flow 3): turn_derivation — the epic's
// biggest single handler — and the two chunk summaries. turn_derivation
// composes the rendering from message-level derivations (compose.ts), sends the
// deterministic rendering through compressSmoothTurn, hands both derivations back
// for the version-checked completion write, and runs placement in that same
// completion transaction via the onApplied hook: open-chunk append, the
// accumulated close policy, and any close's summary enqueues all ride the
// one commit (anti-shim: a crash leaves either a placed turn with queued
// summaries or an open chunk — nothing between).
import { resolveInstancePoke } from "../../shared-tech/index.js";
import type {
  DerivationMetadata,
  HandlerOutcome,
  HandlerRunContext,
  ProviderResult,
  ToolOutcome,
  ToolRunReceipt,
  WorkHandler,
} from "../../shared-tech/index.js";
import { writeLog } from "../../shared-tech/logging/index.js";
import { estimateTokens } from "../../shared-tech/token-counting/index.js";
import type { WorkKind } from "../../shared-tech/work-queue/index.js";
import { truncateForFallback } from "../../shared-tech/index.js";
import {
  cleanPrompt,
  findPairedToolCall,
  toolResultGuidance,
  toolResultTargetTokens,
} from "../../messages/recovery.js";
import {
  composeDerivationKey,
  composeRenderingInput,
  type ComposeDerivationRow,
  type ComposeMessage,
} from "./compose.js";
import { enqueueChunkSummaries, placeTurn } from "./chunks.js";
import {
  chunkExists,
  readMemberMessages,
  readMemberProjections,
  readMessageDerivationRows,
  readTurnSource,
} from "./derivations.js";
import { hasLiveRecoveryWork, recoverDerivation } from "./recovery.js";
import { selectOpenTurnIds } from "./store.js";

function sourceDamaged(reason: string): HandlerOutcome {
  return { ok: false, blocked: true, reason: `source_damaged: ${reason}` };
}

function providerFailed(result: { retryable: boolean; reason: string }): HandlerOutcome {
  return { ok: false, retryable: result.retryable, reason: result.reason };
}

function dependencyNotReady(reason: string): HandlerOutcome {
  return { ok: false, retryable: true, reason };
}

function composeTurnRenderingText(parts: readonly { text: string }[]): string {
  return parts.map((part) => part.text).join(" | ");
}

function detailedReceiptSuffix(memberReceipts: readonly (readonly ToolRunReceipt[])[]): string {
  const receipts = memberReceipts.flat();
  if (receipts.length === 0) return "";
  return `[receipts ${receipts.map((r) => `${r.account}=>${r.outcome}`).join("; ")}]`;
}

function composeDetailedChunkSummary(
  memberProjections: readonly string[],
  memberReceipts: readonly (readonly ToolRunReceipt[])[],
): string {
  return memberProjections.join(" | ") + detailedReceiptSuffix(memberReceipts);
}

function readThreadId(run: HandlerRunContext): string {
  const row = run.openDb().prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`).get() as
    | { thread_id: string }
    | undefined;
  return row?.thread_id ?? "";
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
      clock: run.clock,
      threadId: readThreadId(run),
      onCommit: () => {},
      poke: resolveInstancePoke(),
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

function pairedToolName(
  run: HandlerRunContext,
  messages: readonly ComposeMessage[],
  toolCallId: unknown,
): string {
  if (typeof toolCallId !== "string") return "unknown_tool";
  const sameTurnCall = messages.find((message) => {
    if (message.kind !== "tool_call") return false;
    return message.blocks[0]?.content["toolCallId"] === toolCallId;
  });
  const sameTurnToolName = sameTurnCall?.blocks[0]?.content["toolName"];
  if (typeof sameTurnToolName === "string") return sameTurnToolName;
  return findPairedToolCall(run.openDb(), toolCallId)?.toolName ?? "unknown_tool";
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
    let result: ProviderResult;
    if (message.kind === "user_prompt") {
      const text = typeof block["text"] === "string" ? block["text"] : "";
      const cleaned = cleanPrompt(text);
      result =
        estimateTokens(cleaned) > run.config.smoothing.maxInferenceTokens
          ? { ok: true, text: cleaned }
          : await run.provider.smoothPrompt({ text: cleaned });
    } else {
      const tokens = estimateTokens(content);
      const outcome = toolOutcomeFromMessage(message);
      if (tokens > run.config.toolResult.largeTierTokens) {
        result = { ok: true, text: truncateForFallback(content) };
      } else {
        const targetTokens = toolResultTargetTokens(tokens, run.config);
        const toolName = pairedToolName(run, messages, block["toolCallId"]);
        result =
          tokens <= targetTokens
            ? { ok: true, text: content }
            : await run.provider.summarizeToolResult({
                toolName,
                content,
                outcome,
                targetTokens,
                guidance: toolResultGuidance(toolName),
              });
      }
    }
    if (!result.ok) continue;

    const metadata: DerivationMetadata | undefined =
      message.kind === "tool_result"
        ? {
            outcome: toolOutcomeFromMessage(message),
            ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
          }
        : result.provenance === undefined
          ? undefined
          : { provenance: result.provenance };
    const recovered: ComposeDerivationRow = {
      state: "ready",
      content: result.text,
      sourceVersion: row.sourceVersion,
      ...(metadata === undefined ? {} : { metadata }),
    };
    derivations.set(key, recovered);
    recoverDerivation(run.openDb(), {
      subjectKind: "message",
      subjectId: message.messageId,
      derivationType: plan.derivationType,
      content: result.text,
      ...(recovered.metadata === undefined ? {} : { metadata: recovered.metadata }),
      sourceVersion: row.sourceVersion,
      derivedAt: run.clock().toISOString(),
    });
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
  // lands blocked naming the damage, and requeue refuses with that reason
  // until the source reads clean (Story 4).
  const openTurnIds = selectOpenTurnIds(db);
  if (openTurnIds.length > 1) {
    return sourceDamaged(
      `turn state corrupt: ${openTurnIds.length} turns open (${openTurnIds.join(", ")})`,
    );
  }

  // Compose from current message-derivation states: ready derivations verbatim,
  // non-ready fall back with one gap each (AC-3.2). Pure — both reads land
  // before any provider call, and no transaction is held across them.
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
  const projection = await run.provider.compressSmoothTurn({ rendering: renderingText });
  if (!projection.ok) return providerFailed(projection);

  // The projection's token count is estimated exactly once, here, as the
  // artifact lands; placement reads this stored arithmetic and never
  // re-counts (AC-3.9's determinism input).
  const projectedTokens = estimateTokens(projection.text);
  const threadId = readThreadId(run);
  // Tool-run receipts ride the rendering's metadata, mechanically restated
  // from the composition input (AC-3.8) — the chunk summaries read them from
  // here, never from provider prose.
  const renderingMetadata: DerivationMetadata = {
    ...(receipts.length > 0 ? { receipts } : {}),
  };

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
        ...(projection.provenance === undefined
          ? {}
          : { metadata: { provenance: projection.provenance } }),
      },
    ],
    onApplied: (tx) => {
      const placement = placeTurn(tx.db, turnId, projectedTokens, run.config.chunkPolicy);
      for (const chunkId of placement.closedChunkIds) {
        enqueueChunkSummaries(
          {
            db: tx.db,
            clock: run.clock,
            threadId,
            onCommit: tx.onCommit,
            poke: resolveInstancePoke(),
          },
          chunkId,
        );
      }
    },
  };
};

// One read for both summary kinds — member projections in turn order. Detailed
// is deterministic material assembly from member projections plus full
// tool-run receipts. Brief is still inference-backed and receives outcomes
// only, the receipt text stripped here so the brief provider call structurally
// cannot carry it. Two work items, two handlers' runs, independent retry and
// states. A member whose projection is not ready waits: chunk summary
// derivation is background work, so it requeues until the member lower-band
// input lands.
function chunkSummaryHandler(
  kind: "chunk_summary_detailed" | "chunk_summary_brief",
): WorkHandler {
  return async (run, item) => {
    const chunkId = item.sourceRef["chunkId"];
    if (chunkId === undefined) return sourceDamaged("work item carries no chunkId");
    const db = run.openDb();
    if (!chunkExists(db, chunkId)) return sourceDamaged(`chunk ${chunkId} not found`);

    const members = readMemberProjections(db, chunkId);
    const memberProjections: string[] = [];
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
          `member ${member.turnId} smooth_turn_compression blocked while deriving ${kind}`,
        );
      }
      return dependencyNotReady(
        `member_projection_not_ready: member ${member.turnId} smooth_turn_compression is ${member.state ?? "missing"}`,
      );
    }

    const result =
      kind === "chunk_summary_detailed"
        ? {
            ok: true as const,
            text: composeDetailedChunkSummary(
              memberProjections,
              members.map((member) => member.receipts),
            ),
          }
        : await run.provider.summarizeChunkBrief({
            memberProjections,
            memberOutcomes: members.map((member) =>
              member.receipts.map((receipt) => receipt.outcome),
            ),
          });
    if (!result.ok) return providerFailed(result);

    return {
      ok: true,
      derivations: [
        {
          subjectKind: "chunk",
          subjectId: chunkId,
          derivationType: kind,
          content: result.text,
          ...(result.provenance === undefined
            ? {}
            : { metadata: { provenance: result.provenance } }),
        },
      ],
    };
  };
}

// The domain's handler table, merged into the SDK dispatch map at
// construction (DD-6).
export const turnWorkHandlers: Readonly<Partial<Record<WorkKind, WorkHandler>>> = {
  turn_derivation: turnDerivationHandler,
  chunk_summary_detailed: chunkSummaryHandler("chunk_summary_detailed"),
  chunk_summary_brief: chunkSummaryHandler("chunk_summary_brief"),
};
