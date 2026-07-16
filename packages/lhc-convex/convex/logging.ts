import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { nowIso, resolveThread } from "./common.js";

const logEntry = v.object({
  level: v.union(v.literal("info"), v.literal("warning"), v.literal("error")),
  message: v.string(),
  derivationType: v.optional(v.string()),
  subjectId: v.optional(v.string()),
  reason: v.optional(v.string()),
  floorUsed: v.optional(v.string()),
});

export const write = mutation({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    entry: logEntry,
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const last = await ctx.db
      .query("logs")
      .withIndex("by_instance_and_thread_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread),
      )
      .order("desc")
      .first();
    await ctx.db.insert("logs", {
      instance: args.instance,
      thread: resolved.thread.thread,
      seq: (last?.seq ?? 0) + 1,
      level: args.entry.level,
      message: args.entry.message,
      ...(args.entry.derivationType === undefined ? {} : { deriv: args.entry.derivationType }),
      ...(args.entry.subjectId === undefined ? {} : { subject: args.entry.subjectId }),
      ...(args.entry.reason === undefined ? {} : { reason: args.entry.reason }),
      ...(args.entry.floorUsed === undefined ? {} : { floorUsed: args.entry.floorUsed }),
      recordedAt: nowIso(),
    });
    return { ok: true as const, value: null };
  },
});

export const list = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    filter: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const filter = (args.filter ?? {}) as Record<string, unknown>;
    const rows = await ctx.db
      .query("logs")
      .withIndex("by_instance_and_thread_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread),
      )
      .order("desc")
      .take(32_000);
    return {
      ok: true as const,
      value: rows
        .filter(
          (row) =>
            (filter["level"] === undefined || row.level === filter["level"]) &&
            (filter["derivationType"] === undefined || row.deriv === filter["derivationType"]) &&
            (filter["subjectId"] === undefined || row.subject === filter["subjectId"]) &&
            (filter["reason"] === undefined || row.reason === filter["reason"]),
        )
        .map((row) => ({
          logId: row.seq,
          level: row.level,
          message: row.message,
          derivationType: row.deriv ?? null,
          subjectId: row.subject ?? null,
          reason: row.reason ?? null,
          floorUsed: row.floorUsed ?? null,
          recordedAt: row.recordedAt,
        })),
    };
  },
});

export const listDerivation = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    filter: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const filter = (args.filter ?? {}) as Record<string, unknown>;
    const rows = await ctx.db
      .query("derivationLogs")
      .withIndex("by_instance_and_thread_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread),
      )
      .order("desc")
      .take(32_000);
    return {
      ok: true as const,
      value: rows.filter(
        (row) =>
          (filter["subjectKind"] === undefined || row.scope === filter["subjectKind"]) &&
          (filter["subjectId"] === undefined || row.subject === filter["subjectId"]) &&
          (filter["derivationType"] === undefined || row.deriv === filter["derivationType"]) &&
          (filter["eventKind"] === undefined || row.eventKind === filter["eventKind"]),
      ),
    };
  },
});
