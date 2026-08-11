// Retrieval component ops: getTurns / getMessages serve content by stable id
// under explicit budgets and write one impression row per requested id; the
// impression log is the only write. Mirrors packages/lhc src/retrieval at the
// contract pin, adapted to Convex tables (impressions replace the SQLite
// retrieval_impression table; both ops are mutations because the usage log is
// part of the serving contract).
import { v } from "convex/values";
import {
  budgetWalk,
  type Candidate,
  clampIdEcho,
  dedupe,
  MAX_RETRIEVAL_IDS_PER_CALL,
  resolveBudget,
  resolveByteBudget,
  resolveFromToken,
  RETRIEVAL_ID_PATTERN,
  type RetrievedMessage,
  type RetrievedTurn,
  type SliceReceipt,
  verbatimText,
} from "../src/shared/retrieval.js";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { composeRenderingInput, composeStructuredTurnText } from "../src/shared/turn_compose.js";
import type { RenderingPartKind } from "../src/client/types.js";
import { mutation, type MutationCtx, query } from "./_generated/server.js";
import { composeDerivationKey } from "../src/shared/turn_compose.js";
import { nowIso, resolveThread } from "./common.js";

function systemError(reason: string) {
  return { ok: false as const, error: { errorClass: "system_error" as const, code: "storage_failure", reason } };
}

const optionsValidator = v.optional(
  v.object({
    tokenBudget: v.optional(v.number()),
    byteBudget: v.optional(v.number()),
    fromToken: v.optional(v.number()),
    surface: v.optional(v.string()),
  }),
);

const refValidator = v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) });

async function turnCandidate(
  ctx: MutationCtx,
  instance: string,
  thread: string,
  turnId: string,
): Promise<Candidate<RetrievedTurn>> {
  const turn = await ctx.db
    .query("turns")
    .withIndex("by_instance_and_thread_and_turn", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("turn", turnId),
    )
    .unique();
  if (turn === null) return { id: turnId, outcome: { kind: "unservable", reason: "not_found" } };
  if (turn.deletedAt !== undefined) return { id: turnId, outcome: { kind: "unservable", reason: "deleted" } };

  const stored = await ctx.db
    .query("derivations")
    .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("scope", "turn").eq("subject", turnId).eq("deriv", "turn_rendering"),
    )
    .unique();
  const storedContent = stored?.state === "ready" ? (stored.content ?? null) : null;
  const storedHasTurnLabel =
    typeof storedContent === "string" &&
    storedContent.startsWith(`<${turnId}>\n`) &&
    storedContent.endsWith(`\n</${turnId}>`);
  if (storedHasTurnLabel) {
    const tokens = estimateTokens(storedContent);
    return {
      id: turnId,
      outcome: { kind: "servable", item: { turnId, text: storedContent, tokens, source: "stored" }, tokens },
    };
  }

  // Live fallback: compose from current message forms exactly like the
  // turn_derivation handler would (pure composition, no writes, no inference).
  // Also serves pre-label legacy renderings freshly composed with labels.
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_instance_and_thread_and_turn_and_deletedAt_and_sourceOrder", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("turn", turnId).eq("deletedAt", undefined),
    )
    .take(32_000);
  const members = [];
  const derivations = new Map();
  for (const message of messages) {
    const blocks = await ctx.db
      .query("messageBlocks")
      .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
        q.eq("instance", instance).eq("thread", thread).eq("message", message.message),
      )
      .take(100);
    members.push({
      messageId: message.message,
      kind: message.kind as RenderingPartKind,
      tokenEstimate: message.tokenEstimate,
      blocks: blocks.map((block) => ({ blockType: block.blockType, content: block.content as Record<string, unknown> })),
    });
    for (const deriv of ["smoothed_prompt", "tool_result_summary"]) {
      const row = await ctx.db
        .query("derivations")
        .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
          q
            .eq("instance", instance)
            .eq("thread", thread)
            .eq("scope", "message")
            .eq("subject", message.message)
            .eq("deriv", deriv),
        )
        .unique();
      if (row !== null) {
        derivations.set(composeDerivationKey(message.message, deriv), {
          state: row.state,
          sourceVersion: row.sourceVersion,
          ...(row.content === undefined ? {} : { content: row.content }),
          ...(row.reason === undefined ? {} : { reason: row.reason }),
          ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
        });
      }
    }
  }
  const { parts } = composeRenderingInput(members, derivations);
  const text = composeStructuredTurnText(parts, turnId);
  const tokens = estimateTokens(text);
  return { id: turnId, outcome: { kind: "servable", item: { turnId, text, tokens, source: "composed" }, tokens } };
}

async function messageCandidate(
  ctx: MutationCtx,
  instance: string,
  thread: string,
  messageId: string,
): Promise<Candidate<RetrievedMessage>> {
  const row = await ctx.db
    .query("messages")
    .withIndex("by_instance_and_thread_and_message", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("message", messageId),
    )
    .unique();
  if (row === null) return { id: messageId, outcome: { kind: "unservable", reason: "not_found" } };
  if (row.deletedAt !== undefined) return { id: messageId, outcome: { kind: "unservable", reason: "deleted" } };
  const blocks = await ctx.db
    .query("messageBlocks")
    .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("message", messageId),
    )
    .take(100);
  const text = verbatimText(
    blocks.map((block) => ({ blockType: block.blockType, content: block.content as Record<string, unknown> })),
  );
  const tokens = estimateTokens(text);
  return {
    id: messageId,
    outcome: {
      kind: "servable",
      item: { messageId, turnId: row.turn, kind: row.kind, text, tokens },
      tokens,
    },
  };
}

async function retrieve(
  ctx: MutationCtx,
  args: {
    instance: string;
    ref: { threadId?: string; filePath?: string };
    ids: string[];
    options?: { tokenBudget?: number; byteBudget?: number; fromToken?: number; surface?: string };
  },
  defaultSurface: "get_turns" | "get_messages",
  entityKind: "turn" | "message",
) {
  let tokenBudget: number;
  let byteBudget: number;
  let fromToken: number;
  try {
    tokenBudget = resolveBudget(args.options);
    byteBudget = resolveByteBudget(args.options);
    fromToken = resolveFromToken(args.options);
  } catch (cause) {
    return systemError(cause instanceof Error ? cause.message : String(cause));
  }
  if (args.ids.length === 0) {
    return systemError(`${defaultSurface}: at least one id is required`);
  }
  // Hard bound on the whole model-visible result: bodies are budgeted, but
  // receipts/footers scale with id count — unbounded ids means unbounded
  // output. Refuse over-cap calls whole with a receipt naming the cap.
  if (dedupe(args.ids).length > MAX_RETRIEVAL_IDS_PER_CALL) {
    return systemError(
      `${defaultSurface}: too many ids — ${dedupe(args.ids).length} requested, cap is ${MAX_RETRIEVAL_IDS_PER_CALL} per call; split the request`,
    );
  }
  const resolved = await resolveThread(ctx.db, args.instance, args.ref);
  if (!resolved.ok) return resolved;
  const thread = resolved.thread.thread;
  const surface = args.options?.surface ?? defaultSurface;
  const callId = crypto.randomUUID();

  const candidates: Array<Candidate<RetrievedTurn | RetrievedMessage>> = [];
  for (const id of dedupe(args.ids)) {
    if (!RETRIEVAL_ID_PATTERN.test(id)) {
      candidates.push({ id: clampIdEcho(id), outcome: { kind: "unservable", reason: "invalid" } });
    } else if (entityKind === "turn") {
      candidates.push(await turnCandidate(ctx, args.instance, thread, id));
    } else {
      candidates.push(await messageCandidate(ctx, args.instance, thread, id));
    }
  }
  const walk = budgetWalk(candidates, entityKind, tokenBudget, byteBudget, fromToken);

  const lastImpression = await ctx.db
    .query("impressions")
    .withIndex("by_instance_and_thread_and_seq", (q) => q.eq("instance", args.instance).eq("thread", thread))
    .order("desc")
    .first();
  let seq = (lastImpression?.seq ?? 0) + 1;
  const timestamp = nowIso();
  for (const row of walk.impressions) {
    await ctx.db.insert("impressions", {
      instance: args.instance,
      thread,
      seq,
      callId,
      surface,
      entityKind: row.entityKind,
      entityId: row.entityId,
      requestIdx: row.requestIdx,
      served: row.served,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(row.tokens === undefined ? {} : { tokens: row.tokens }),
      recordedAt: timestamp,
    });
    seq += 1;
  }
  return {
    ok: true as const,
    value: {
      callId,
      served: walk.served as Array<(RetrievedTurn | RetrievedMessage) & { slice?: SliceReceipt }>,
      unserved: walk.unserved,
      totalTokens: walk.totalTokens,
      tokenBudget,
    },
  };
}

export const getTurns = mutation({
  args: { instance: v.string(), ref: refValidator, ids: v.array(v.string()), options: optionsValidator },
  handler: async (ctx, args) => retrieve(ctx, args, "get_turns", "turn"),
});

export const getMessages = mutation({
  args: { instance: v.string(), ref: refValidator, ids: v.array(v.string()), options: optionsValidator },
  handler: async (ctx, args) => retrieve(ctx, args, "get_messages", "message"),
});

/** Impression read-back (inspection/test seam; ranking work reads this later). */
export const listImpressions = query({
  args: { instance: v.string(), ref: refValidator },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const rows = await ctx.db
      .query("impressions")
      .withIndex("by_instance_and_thread_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread),
      )
      .take(32_000);
    return {
      ok: true as const,
      value: rows.map((row) => ({
        callId: row.callId,
        surface: row.surface,
        entityKind: row.entityKind,
        entityId: row.entityId,
        requestIdx: row.requestIdx,
        served: row.served,
        reason: row.reason ?? null,
        tokens: row.tokens ?? null,
        recordedAt: row.recordedAt,
      })),
    };
  },
});
