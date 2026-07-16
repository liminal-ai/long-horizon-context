import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { type ActionCtx, action, mutation, query } from "./_generated/server.js";
import { resolveThread } from "./common.js";
import { drainWork, scheduleDrain } from "./queue.js";

export const drain = action({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    maxItems: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const resolved: { ok: true; thread: string } | { ok: false; error: unknown } = await ctx.runQuery(
      internal.queue.resolveRef,
      { instance: args.instance, ref: args.ref },
    );
    if (!resolved.ok) return resolved as unknown as Record<string, unknown>;
    const value = await drainWork(ctx, {
      instance: args.instance,
      thread: resolved.thread,
      ...(args.maxItems === undefined ? {} : { maxItems: args.maxItems }),
    });
    return { ok: true, value };
  },
});

export const status = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const scheduled =
      resolved.thread.scheduledDrainId === undefined
        ? null
        : await ctx.db.system.get("_scheduled_functions", resolved.thread.scheduledDrainId);
    const scheduledKind = scheduled?.state.kind;
    const drainScheduled = scheduledKind === "pending" || scheduledKind === "inProgress";
    const queued = await ctx.db
      .query("workItems")
      .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread).eq("status", "queued"),
      )
      .take(32_000);
    const running = await ctx.db
      .query("workItems")
      .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread).eq("status", "running"),
      )
      .take(32_000);
    return {
      ok: true as const,
      value: { queued: queued.length, running: running.length, drainScheduled },
    };
  },
});

export const touch = mutation({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const scheduled = await scheduleDrain(ctx, resolved.thread);
    return { ok: true as const, value: { scheduled } };
  },
});

type ResolvedThread = { ok: true; thread: string } | { ok: false; error: unknown };
type DeriveOneResult =
  | { ok: true; thread: string; sourceVersion: number }
  | { ok: true; outcome: "not_derivable"; subject: string }
  | { ok: false; [key: string]: unknown };

async function resolvedThread(
  ctx: ActionCtx,
  instance: string,
  ref: { threadId?: string; filePath?: string },
): Promise<ResolvedThread> {
  return (await ctx.runQuery(internal.queue.resolveRef, { instance, ref })) as
    | { ok: true; thread: string }
    | { ok: false; error: unknown };
}

async function deriveOne(
  ctx: ActionCtx,
  args: {
    instance: string;
    ref: { threadId?: string; filePath?: string };
    scope: "message" | "turn" | "chunk";
    subject: string;
    deriv?: string;
  },
): Promise<DeriveOneResult> {
  const resolved: ResolvedThread = await resolvedThread(ctx, args.instance, args.ref);
  if (!resolved.ok) return resolved;
  const prepared = (await ctx.runMutation(internal.queue.prepareExplicitDerive, {
    instance: args.instance,
    thread: resolved.thread,
    scope: args.scope,
    subject: args.subject,
    ...(args.deriv === undefined ? {} : { deriv: args.deriv }),
  })) as Record<string, unknown>;
  if (prepared["ok"] !== true) return { ok: false as const, ...prepared };
  if (prepared["outcome"] === "not_derivable") {
    return { ok: true as const, outcome: "not_derivable" as const, subject: args.subject };
  }
  await drainWork(ctx, { instance: args.instance, thread: resolved.thread });
  return { ok: true as const, thread: resolved.thread, sourceVersion: prepared["sourceVersion"] as number };
}

export const deriveMessages = action({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    messageIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const values: Array<Record<string, unknown>> = [];
    for (const messageId of args.messageIds) {
      const derived = await deriveOne(ctx, { ...args, scope: "message", subject: messageId });
      if (derived.ok !== true) return { ok: false as const, error: derived };
      if ("outcome" in derived) {
        values.push({ messageId, outcome: "not_derivable" as const });
      } else {
        values.push({ messageId, outcome: "derived" as const, sourceVersion: derived.sourceVersion });
      }
    }
    return { ok: true as const, value: values };
  },
});

export const deriveTurn = action({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    turnId: v.string(),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const derived = await deriveOne(ctx, { ...args, scope: "turn", subject: args.turnId });
    if (derived.ok !== true) return { ok: false as const, error: derived };
    if (!("sourceVersion" in derived)) return { ok: false as const, error: derived };
    return {
      ok: true as const,
      value: { turnId: args.turnId, outcome: "derived" as const, sourceVersion: derived.sourceVersion },
    };
  },
});

export const deriveChunk = action({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    chunkId: v.string(),
    derivationType: v.union(v.literal("chunk_summary_detailed"), v.literal("chunk_summary_brief")),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const derived = await deriveOne(ctx, {
      ...args,
      scope: "chunk",
      subject: args.chunkId,
      deriv: args.derivationType,
    });
    if (derived.ok !== true) return { ok: false as const, error: derived };
    if (!("sourceVersion" in derived)) return { ok: false as const, error: derived };
    return {
      ok: true as const,
      value: {
        chunkId: args.chunkId,
        outcome: "derived" as const,
        derivationType: args.derivationType,
        sourceVersion: derived.sourceVersion,
      },
    };
  },
});
