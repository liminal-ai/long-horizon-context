import { v } from "convex/values";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { mutation, query } from "./_generated/server.js";
import {
  callerError,
  enqueueWork,
  nowIso,
  type QueueCursor,
  readInstance,
  resolveThread,
  type ThreadDoc,
} from "./common.js";
import { scheduleDrain } from "./queue.js";

async function blocksFor(ctx: QueryCtx, instance: string, thread: string, message: string) {
  const rows = await ctx.db
    .query("messageBlocks")
    .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("message", message),
    )
    .take(8_192);
  return rows.map((row) => ({ blockType: row.blockType, content: row.content as Record<string, unknown> }));
}

async function derivationsFor(
  ctx: QueryCtx,
  instance: string,
  thread: string,
  scope: "message" | "turn" | "chunk",
  subject: string,
) {
  const rows = await ctx.db
    .query("derivations")
    .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("scope", scope).eq("subject", subject),
    )
    .take(100);
  return rows.map((row) => ({
    subjectKind: row.scope,
    subjectId: row.subject,
    derivationType: row.deriv,
    state: row.state,
    sourceVersion: row.sourceVersion,
    ...(row.content === undefined ? {} : { content: row.content }),
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
    ...(row.gaps === undefined ? {} : { gaps: row.gaps }),
    ...(row.derivedAt === undefined ? {} : { derivedAt: row.derivedAt }),
  }));
}

async function messageRecord(ctx: QueryCtx, row: Doc<"messages">) {
  const derivations = await derivationsFor(ctx, row.instance, row.thread, "message", row.message);
  return {
    messageId: row.message,
    sourceEventOrder: row.sourceOrder,
    kind: row.kind,
    blocks: await blocksFor(ctx, row.instance, row.thread, row.message),
    tokenEstimate: row.tokenEstimate,
    actor: row.actor,
    harness: row.harness,
    recordedAt: row.recordedAt,
    turnId: row.turn,
    ...(derivations.length === 0 ? {} : { derivations }),
    ...(row.deletedAt === undefined ? {} : { deleted: true }),
  };
}

function validateBounds(options: Record<string, unknown>) {
  for (const name of ["from", "to", "limit"] as const) {
    const value = options[name];
    if (value !== undefined && !Number.isInteger(value)) {
      return callerError("invalid_bounds", `${name} must be an integer, got ${String(value)}`);
    }
  }
  if (typeof options["from"] === "number" && typeof options["to"] === "number" && options["from"] > options["to"]) {
    return callerError("invalid_bounds", `from (${options["from"]}) must not exceed to (${options["to"]})`);
  }
  if (typeof options["limit"] === "number" && options["limit"] < 1) {
    return callerError("invalid_bounds", `limit must be at least 1, got ${options["limit"]}`);
  }
  return null;
}

export const listMessages = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    options: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const options = (args.options ?? {}) as Record<string, unknown>;
    const invalid = validateBounds(options);
    if (invalid !== null) return invalid;
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const from = typeof options["from"] === "number" ? options["from"] : undefined;
    const to = typeof options["to"] === "number" ? options["to"] : undefined;
    const limit = typeof options["limit"] === "number" ? options["limit"] : 32_000;
    const rows =
      options["includeDeleted"] === true
        ? await ctx.db
            .query("messages")
            .withIndex("by_instance_and_thread_and_sourceOrder", (q) => {
              const base = q.eq("instance", args.instance).eq("thread", resolved.thread.thread);
              if (from !== undefined && to !== undefined) return base.gte("sourceOrder", from).lte("sourceOrder", to);
              if (from !== undefined) return base.gte("sourceOrder", from);
              if (to !== undefined) return base.lte("sourceOrder", to);
              return base;
            })
            .take(limit)
        : await ctx.db
            .query("messages")
            .withIndex("by_instance_and_thread_and_deletedAt_and_sourceOrder", (q) => {
              const base = q
                .eq("instance", args.instance)
                .eq("thread", resolved.thread.thread)
                .eq("deletedAt", undefined);
              if (from !== undefined && to !== undefined) return base.gte("sourceOrder", from).lte("sourceOrder", to);
              if (from !== undefined) return base.gte("sourceOrder", from);
              if (to !== undefined) return base.lte("sourceOrder", to);
              return base;
            })
            .take(limit);
    const records = [];
    for (const row of rows) records.push(await messageRecord(ctx, row));
    return { ok: true as const, value: records };
  },
});

export const showMessage = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    messageId: v.string(),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const row = await ctx.db
      .query("messages")
      .withIndex("by_instance_and_thread_and_message", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread).eq("message", args.messageId),
      )
      .unique();
    if (row === null) return callerError("message_not_found", `no message ${args.messageId} exists in this thread`);
    const record = await messageRecord(ctx, row);
    return {
      ok: true as const,
      value: { ...record, deleted: row.deletedAt !== undefined, derivations: record.derivations ?? [] },
    };
  },
});

export const listTurns = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const rows = await ctx.db
      .query("turns")
      .withIndex("by_instance_and_thread_and_deletedAt_and_turnOrder", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread).eq("deletedAt", undefined),
      )
      .take(32_000);
    const records = [];
    for (const row of rows) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_instance_and_thread_and_turn_and_deletedAt_and_sourceOrder", (q) =>
          q
            .eq("instance", args.instance)
            .eq("thread", row.thread)
            .eq("turn", row.turn)
            .eq("deletedAt", undefined),
        )
        .take(32_000);
      const placement = await ctx.db
        .query("chunkMembers")
        .withIndex("by_instance_and_thread_and_turn", (q) =>
          q.eq("instance", args.instance).eq("thread", row.thread).eq("turn", row.turn),
        )
        .unique();
      const derivations = await derivationsFor(ctx, args.instance, row.thread, "turn", row.turn);
      records.push({
        turnId: row.turn,
        turnOrder: row.turnOrder,
        status: row.status,
        memberMessageIds: messages.map((message) => message.message),
        openedAtEventOrder: row.openedAtEventOrder,
        ...(row.closedAtEventOrder === undefined ? {} : { closedAtEventOrder: row.closedAtEventOrder }),
        ...(placement === null ? {} : { chunkId: placement.chunk, memberIdx: placement.memberIdx }),
        ...(derivations.length === 0 ? {} : { derivations }),
      });
    }
    return { ok: true as const, value: records };
  },
});

export const listChunks = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const rows = await ctx.db
      .query("chunks")
      .withIndex("by_instance_and_thread_and_chunkOrder", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread),
      )
      .take(32_000);
    const records = [];
    for (const row of rows) {
      const members = await ctx.db
        .query("chunkMembers")
        .withIndex("by_instance_and_thread_and_chunk_and_memberIdx", (q) =>
          q.eq("instance", args.instance).eq("thread", row.thread).eq("chunk", row.chunk),
        )
        .take(32_000);
      const derivations = await derivationsFor(ctx, args.instance, row.thread, "chunk", row.chunk);
      records.push({
        chunkId: row.chunk,
        chunkOrder: row.chunkOrder,
        status: row.status,
        accumulatedProjectedTokens: row.accumulatedProjectedTokens,
        memberTurnIds: members.map((member) => member.turn),
        ...(derivations.length === 0 ? {} : { derivations }),
      });
    }
    return { ok: true as const, value: records };
  },
});

export const reportDerivations = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    scope: v.union(v.literal("message"), v.literal("turn"), v.literal("chunk")),
    subject: v.optional(v.string()),
    notReady: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const all = await ctx.db
      .query("derivations")
      .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) => {
        const base = q.eq("instance", args.instance).eq("thread", resolved.thread.thread).eq("scope", args.scope);
        return args.subject === undefined ? base : base.eq("subject", args.subject);
      })
      .take(32_000);
    const [queuedWork, runningWork] = await Promise.all([
      ctx.db
        .query("workItems")
        .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
          q.eq("instance", args.instance).eq("thread", resolved.thread.thread).eq("status", "queued"),
        )
        .take(32_000),
      ctx.db
        .query("workItems")
        .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
          q.eq("instance", args.instance).eq("thread", resolved.thread.thread).eq("status", "running"),
        )
        .take(32_000),
    ]);
    const queueByDerivation = new Map<string, "queued" | "running">();
    for (const item of [...queuedWork, ...runningWork]) {
      for (const target of item.derivs) {
        if (target.scope === args.scope) {
          queueByDerivation.set(`${target.scope}/${target.subject}/${target.deriv}/${item.sourceVersion}`, item.status);
        }
      }
    }
    const rows = args.notReady === true ? all.filter((row) => row.state !== "ready") : all;
    return {
      ok: true as const,
      value: rows.map((row) => ({
        subjectKind: row.scope,
        subjectId: row.subject,
        derivationType: row.deriv,
        state: row.state,
        sourceVersion: row.sourceVersion,
        ...(row.content === undefined ? {} : { content: row.content }),
        ...(row.reason === undefined ? {} : { reason: row.reason }),
        ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
        ...(row.gaps === undefined ? {} : { gaps: row.gaps }),
        ...(row.derivedAt === undefined ? {} : { derivedAt: row.derivedAt }),
        ...(queueByDerivation.get(`${row.scope}/${row.subject}/${row.deriv}/${row.sourceVersion}`) === undefined
          ? {}
          : {
              queue: {
                status: queueByDerivation.get(`${row.scope}/${row.subject}/${row.deriv}/${row.sourceVersion}`),
              },
            }),
      })),
    };
  },
});

const rebuildKind: Record<string, string> = {
  smoothed_prompt: "prompt_smoothing",
  tool_result_summary: "tool_result_summary",
  turn_rendering: "turn_derivation",
  pre_detailed_assembly: "turn_derivation",
  detailed_turn_compression: "detailed_turn_compression",
  chunk_summary_detailed: "chunk_summary_detailed",
  chunk_summary_brief: "chunk_summary_brief",
};

const rebuildOrder: Record<string, number> = {
  prompt_smoothing: 0,
  tool_result_summary: 1,
  turn_derivation: 2,
  detailed_turn_compression: 3,
  chunk_summary_detailed: 4,
  chunk_summary_brief: 5,
};

type CascadeSubject = { scope: "message" | "turn" | "chunk"; subject: string };

function sourceRef(subject: CascadeSubject): Record<string, string> {
  if (subject.scope === "message") return { messageId: subject.subject };
  if (subject.scope === "turn") return { turnId: subject.subject };
  return { chunkId: subject.subject };
}

async function cascadeSubjects(
  ctx: MutationCtx,
  thread: ThreadDoc,
  message: Doc<"messages">,
): Promise<CascadeSubject[]> {
  const subjects: CascadeSubject[] = [
    { scope: "message", subject: message.message },
    { scope: "turn", subject: message.turn },
  ];
  const placement = await ctx.db
    .query("chunkMembers")
    .withIndex("by_instance_and_thread_and_turn", (q) =>
      q.eq("instance", thread.instance).eq("thread", thread.thread).eq("turn", message.turn),
    )
    .unique();
  if (placement !== null) subjects.push({ scope: "chunk", subject: placement.chunk });
  return subjects;
}

async function pairedCounterpart(
  ctx: MutationCtx,
  thread: ThreadDoc,
  message: Doc<"messages">,
): Promise<CascadeSubject | null> {
  const ownBlocks = await ctx.db
    .query("messageBlocks")
    .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
      q.eq("instance", thread.instance).eq("thread", thread.thread).eq("message", message.message),
    )
    .take(100);
  const own = ownBlocks.find((block) => block.blockType === "tool_call" || block.blockType === "tool_result");
  const content = own?.content as Record<string, unknown> | undefined;
  const callId = content?.["toolCallId"];
  if (own === undefined || typeof callId !== "string") return null;
  const counterpartType = own.blockType === "tool_call" ? "tool_result" : "tool_call";
  const allBlocks = await ctx.db
    .query("messageBlocks")
    .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
      q.eq("instance", thread.instance).eq("thread", thread.thread),
    )
    .take(32_000);
  for (const block of allBlocks) {
    const blockContent = block.content as Record<string, unknown>;
    if (block.blockType !== counterpartType || blockContent["toolCallId"] !== callId) continue;
    const counterpart = await ctx.db
      .query("messages")
      .withIndex("by_instance_and_thread_and_message", (q) =>
        q.eq("instance", thread.instance).eq("thread", thread.thread).eq("message", block.message),
      )
      .unique();
    if (counterpart !== null && counterpart.deletedAt === undefined) {
      return { scope: "message", subject: counterpart.message };
    }
  }
  return null;
}

async function cascadeMessage(ctx: MutationCtx, thread: ThreadDoc, message: Doc<"messages">, deleteOwn: boolean) {
  const chain = await cascadeSubjects(ctx, thread, message);
  const counterpart = await pairedCounterpart(ctx, thread, message);
  const drop = deleteOwn ? [chain[0]!] : [];
  const clear = deleteOwn ? chain.slice(1) : [...chain];
  if (counterpart !== null) clear.push(counterpart);
  const dropped: Array<Record<string, string>> = [];
  for (const subject of drop) {
    const rows = await ctx.db
      .query("derivations")
      .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
        q
          .eq("instance", thread.instance)
          .eq("thread", thread.thread)
          .eq("scope", subject.scope)
          .eq("subject", subject.subject),
      )
      .take(100);
    for (const row of rows) {
      dropped.push({ subjectKind: subject.scope, subjectId: subject.subject, derivationType: row.deriv });
      await ctx.db.delete("derivations", row._id);
    }
  }

  const groups = new Map<
    string,
    {
      subject: CascadeSubject;
      kind: string;
      rows: Array<Doc<"derivations">>;
      sourceVersion: number;
    }
  >();
  const cleared: Array<Record<string, string>> = [];
  for (const subject of clear) {
    const rows = await ctx.db
      .query("derivations")
      .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
        q
          .eq("instance", thread.instance)
          .eq("thread", thread.thread)
          .eq("scope", subject.scope)
          .eq("subject", subject.subject),
      )
      .take(100);
    for (const row of rows) {
      const kind = rebuildKind[row.deriv];
      if (kind === undefined) throw new Error(`no rebuild work kind mapped for derivation ${row.deriv}`);
      cleared.push({ subjectKind: subject.scope, subjectId: subject.subject, derivationType: row.deriv });
      const key = `${subject.scope}:${subject.subject}:${kind}`;
      const group = groups.get(key) ?? { subject, kind, rows: [], sourceVersion: 0 };
      group.rows.push(row);
      group.sourceVersion = Math.max(group.sourceVersion, row.sourceVersion + 1);
      groups.set(key, group);
    }
  }

  const queuedRows = await ctx.db
    .query("workItems")
    .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
      q.eq("instance", thread.instance).eq("thread", thread.thread).eq("status", "queued"),
    )
    .take(32_000);
  const superseded: string[] = [];
  const affected = [
    ...drop.map((subject) => ({ subject, kinds: null })),
    ...[...groups.values()].map((group) => ({ subject: group.subject, kinds: new Set([group.kind]) })),
  ];
  for (const item of queuedRows) {
    const match = affected.some(({ subject, kinds }) => {
      const ref = sourceRef(subject);
      const key = Object.keys(ref)[0]!;
      return (kinds === null || kinds.has(item.kind)) && (item.sourceRef as Record<string, string>)[key] === ref[key];
    });
    if (match) {
      superseded.push(item.workItem);
      await ctx.db.delete("workItems", item._id);
    }
  }

  const cursor: QueueCursor = { next: thread.nextWorkSequence };
  const queued: Array<{ workItemId: string; kind: string }> = [];
  for (const group of [...groups.values()].sort((a, b) => rebuildOrder[a.kind]! - rebuildOrder[b.kind]!)) {
    const item = await enqueueWork(ctx, thread, cursor, {
      owner: group.subject.scope === "message" ? "messages" : "turns",
      kind: group.kind,
      sourceRef: sourceRef(group.subject),
      sourceVersion: group.sourceVersion,
      derivations: group.rows.map((row) => ({ scope: row.scope, subject: row.subject, deriv: row.deriv })),
    });
    queued.push({ workItemId: item.workItemId, kind: group.kind });
  }
  await ctx.db.patch("threads", thread._id, { nextWorkSequence: cursor.next });
  const instance = await readInstance(ctx.db, thread.instance);
  if (
    instance?.config !== undefined &&
    (instance.config as { mode?: string }).mode === "background" &&
    queued.length > 0
  ) {
    const refreshed = await ctx.db.get("threads", thread._id);
    if (refreshed !== null) await scheduleDrain(ctx, refreshed);
  }
  return { cleared, dropped, queued, superseded };
}

async function mutableTarget(
  ctx: MutationCtx,
  instance: string,
  ref: { threadId?: string; filePath?: string },
  messageId: string,
) {
  const resolved = await resolveThread(ctx.db, instance, ref);
  if (!resolved.ok) return resolved;
  const message = await ctx.db
    .query("messages")
    .withIndex("by_instance_and_thread_and_message", (q) =>
      q.eq("instance", instance).eq("thread", resolved.thread.thread).eq("message", messageId),
    )
    .unique();
  if (message === null || message.deletedAt !== undefined) {
    return callerError("message_not_found", `no message ${messageId} exists in this thread`);
  }
  const turn = await ctx.db
    .query("turns")
    .withIndex("by_instance_and_thread_and_turn", (q) =>
      q.eq("instance", instance).eq("thread", resolved.thread.thread).eq("turn", message.turn),
    )
    .unique();
  if (turn?.status !== "closed") {
    return callerError(
      "turn_open",
      `message ${messageId} belongs to open turn ${message.turn}; open-turn messages cannot be mutated`,
    );
  }
  return { ok: true as const, thread: resolved.thread, message };
}

export const editMessage = mutation({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    messageId: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const target = await mutableTarget(ctx, args.instance, args.ref, args.messageId);
    if (!target.ok) return target;
    const blocks = await ctx.db
      .query("messageBlocks")
      .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
        q.eq("instance", args.instance).eq("thread", target.thread.thread).eq("message", args.messageId),
      )
      .take(100);
    let tokenEstimate = estimateTokens(args.content);
    for (const block of blocks) {
      const content = { ...(block.content as Record<string, unknown>) };
      if (block.blockType === "text") content["text"] = args.content;
      else if (block.blockType === "tool_result") content["content"] = args.content;
      else if (block.blockType === "tool_call") {
        content["arguments"] = args.content;
        tokenEstimate = estimateTokens(JSON.stringify(args.content));
      } else if (block.blockType === "model_change") content["newModel"] = args.content;
      else if (block.blockType === "thinking_level_change") content["newLevel"] = args.content;
      else throw new Error(`message ${args.messageId} carries unknown block type ${block.blockType}`);
      await ctx.db.patch("messageBlocks", block._id, { content });
    }
    await ctx.db.patch("messages", target.message._id, { tokenEstimate });
    const cascade = await cascadeMessage(ctx, target.thread, target.message, false);
    return {
      ok: true as const,
      value: { changed: { messageIds: [args.messageId], turnIds: [] }, ...cascade },
    };
  },
});

export const removeMessage = mutation({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    messageId: v.string(),
  },
  handler: async (ctx, args) => {
    const target = await mutableTarget(ctx, args.instance, args.ref, args.messageId);
    if (!target.ok) return target;
    const first = await ctx.db
      .query("messages")
      .withIndex("by_instance_and_thread_and_turn_and_deletedAt_and_sourceOrder", (q) =>
        q
          .eq("instance", args.instance)
          .eq("thread", target.thread.thread)
          .eq("turn", target.message.turn)
          .eq("deletedAt", undefined),
      )
      .first();
    if (first?._id === target.message._id) {
      return callerError(
        "message_initiates_turn",
        `message ${args.messageId} is the prompt that initiates turn ${target.message.turn}; deleting the initiating prompt is not supported`,
      );
    }
    await ctx.db.patch("messages", target.message._id, { deletedAt: nowIso() });
    const cascade = await cascadeMessage(ctx, target.thread, target.message, true);
    return {
      ok: true as const,
      value: { changed: { messageIds: [args.messageId], turnIds: [] }, ...cascade },
    };
  },
});
