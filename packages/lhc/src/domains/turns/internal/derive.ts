// The turns derivation handlers (Flow 3): turn_derivation — the epic's
// biggest single handler — and the two chunk summaries. turn_derivation
// composes the rendering from message-level forms (compose.ts), sends it
// through composeTurnRendering then projectLowerBand, hands both forms back
// for the version-checked completion write, and runs placement in that same
// completion transaction via the onApplied hook: open-chunk append, the
// accumulated close policy, and any close's summary enqueues all ride the
// one commit (anti-shim: a crash leaves either a placed turn with queued
// summaries or an open chunk — nothing between).
import { resolveInstancePoke } from "../../../shared/context.js";
import type {
  DependencyGap,
  HandlerOutcome,
  HandlerRunContext,
  WorkHandler,
} from "../../../shared/derivation.js";
import { estimateTokens } from "../../../tech-utils/token-counting/index.js";
import type { WorkKind } from "../../../tech-utils/work-queue/index.js";
import { composeRenderingInput } from "./compose.js";
import { enqueueChunkSummaries, placeTurn } from "./chunks.js";
import {
  chunkExists,
  readMemberMessages,
  readMemberProjections,
  readMessageFormRows,
  readTurnSource,
} from "./forms.js";
import { selectOpenTurnIds } from "./store.js";

function sourceDamaged(reason: string): HandlerOutcome {
  return { ok: false, blocked: true, reason: `source_damaged: ${reason}` };
}

function providerFailed(result: { retryable: boolean; reason: string }): HandlerOutcome {
  return { ok: false, retryable: result.retryable, reason: result.reason };
}

function readThreadId(run: HandlerRunContext): string {
  const row = run.openDb().prepare(`SELECT thread_id FROM thread_metadata WHERE id = 1`).get() as
    | { thread_id: string }
    | undefined;
  return row?.thread_id ?? "";
}

const turnDerivationHandler: WorkHandler = async (run, item) => {
  const turnId = item.sourceRef["turnId"];
  if (turnId === undefined) return sourceDamaged("work item carries no turnId");
  const db = run.openDb();
  const turn = readTurnSource(db, turnId);
  if (turn === undefined || turn.deleted) {
    // A deleted turn's form rows were dropped with it, so a blocked stamp
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
  // handler must not compose against a membership it cannot trust; the form
  // lands blocked naming the damage, and requeue refuses with that reason
  // until the source reads clean (Story 4).
  const openTurnIds = selectOpenTurnIds(db);
  if (openTurnIds.length > 1) {
    return sourceDamaged(
      `turn state corrupt: ${openTurnIds.length} turns open (${openTurnIds.join(", ")})`,
    );
  }

  // Compose from current message-form states: ready forms verbatim,
  // non-ready fall back with one gap each (AC-3.2). Pure — both reads land
  // before any provider call, and no transaction is held across them.
  const messages = readMemberMessages(db, turnId);
  const forms = readMessageFormRows(
    db,
    messages.map((message) => message.messageId),
  );
  const { parts, gaps, receipts } = composeRenderingInput(messages, forms);

  const rendering = await run.provider.composeTurnRendering({ parts });
  if (!rendering.ok) return providerFailed(rendering);
  const projection = await run.provider.projectLowerBand({ rendering: rendering.text });
  if (!projection.ok) return providerFailed(projection);

  // The projection's token count is estimated exactly once, here, as the
  // artifact lands; placement reads this stored arithmetic and never
  // re-counts (AC-3.9's determinism input).
  const projectedTokens = estimateTokens(projection.text);
  const threadId = readThreadId(run);
  const renderingGaps: DependencyGap[] | undefined = gaps.length > 0 ? gaps : undefined;

  return {
    ok: true,
    forms: [
      {
        subjectKind: "turn",
        subjectId: turnId,
        form: "turn_rendering",
        content: rendering.text,
        ...(renderingGaps === undefined ? {} : { gaps: renderingGaps }),
        // Tool-run receipts ride the rendering's metadata, mechanically
        // restated from the composition input (AC-3.8) — the chunk
        // summaries read them from here, never from provider prose.
        ...(receipts.length > 0 ? { metadata: { receipts } } : {}),
      },
      {
        subjectKind: "turn",
        subjectId: turnId,
        form: "lower_band_projection",
        content: projection.text,
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

// One read for both summary kinds — member projections in turn order — but
// two contracts at the provider seam (AC-3.8): detailed receives the
// members' tool-run receipts (what changed, outcome) read from the
// renderings' stamped metadata; brief receives outcomes only, the receipt
// text stripped here so the brief provider call structurally cannot carry
// it. Two work items, two handlers' runs, independent retry and states. A
// member whose projection is not ready falls back to nothing and records a
// gap, mirroring the rendering's fallback rule.
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
    const gaps: DependencyGap[] = [];
    for (const member of members) {
      if (member.state === "ready" && member.content !== undefined) {
        memberProjections.push(member.content);
      } else {
        memberProjections.push("");
        gaps.push({
          subjectKind: "turn",
          subjectId: member.turnId,
          form: "lower_band_projection",
        });
      }
    }

    const result =
      kind === "chunk_summary_detailed"
        ? await run.provider.summarizeChunkDetailed({
            memberProjections,
            memberReceipts: members.map((member) => member.receipts),
          })
        : await run.provider.summarizeChunkBrief({
            memberProjections,
            memberOutcomes: members.map((member) =>
              member.receipts.map((receipt) => receipt.outcome),
            ),
          });
    if (!result.ok) return providerFailed(result);

    return {
      ok: true,
      forms: [
        {
          subjectKind: "chunk",
          subjectId: chunkId,
          form: kind,
          content: result.text,
          ...(gaps.length > 0 ? { gaps } : {}),
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
