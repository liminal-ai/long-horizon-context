import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { callerError, nowIso, resolveThread, upsertInstance } from "./common.js";

function hashHex(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export const newThread = mutation({
  args: {
    instance: v.string(),
    config: v.any(),
    modelCallHandle: v.string(),
    input: v.object({
      filePath: v.string(),
      title: v.optional(v.string()),
      cwd: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    if (args.input.filePath.trim() === "") {
      return callerError("invalid_thread_ref", "filePath must be a non-empty alias; received a blank string");
    }
    await upsertInstance(ctx, args);
    const existing = await ctx.db
      .query("threads")
      .withIndex("by_instance_and_filePath", (q) => q.eq("instance", args.instance).eq("filePath", args.input.filePath))
      .unique();
    if (existing !== null) {
      return callerError("path_exists", `a thread already exists at alias ${args.input.filePath}`);
    }
    const createdAt = nowIso();
    const provisional = `pending:${args.input.filePath}`;
    const id = await ctx.db.insert("threads", {
      instance: args.instance,
      thread: provisional,
      filePath: args.input.filePath,
      ...(args.input.title === undefined ? {} : { title: args.input.title }),
      ...(args.input.cwd === undefined ? {} : { cwd: args.input.cwd }),
      createdAt,
      nextEventOrder: 1,
      nextTurnOrder: 2,
      nextChunkOrder: 1,
      nextWorkSequence: 1,
    });
    const threadId = `th_${hashHex(String(id))}`;
    await ctx.db.patch("threads", id, { thread: threadId });
    await ctx.db.insert("turns", {
      instance: args.instance,
      thread: threadId,
      turn: "t1",
      turnOrder: 1,
      status: "open",
      openedAtEventOrder: 0,
    });
    await ctx.db.insert("viewBoundaries", {
      instance: args.instance,
      thread: threadId,
      position: 0,
      updatedAt: createdAt,
    });
    return { ok: true as const, value: { threadId, filePath: args.input.filePath } };
  },
});

export const resolve = query({
  args: { instance: v.string(), threadId: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, { threadId: args.threadId });
    if (!resolved.ok) return resolved;
    const row = resolved.thread;
    return {
      ok: true as const,
      value: {
        threadId: row.thread,
        filePath: row.filePath,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        createdAt: row.createdAt,
      },
    };
  },
});

export const list = query({
  args: { instance: v.string(), cwd: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows =
      args.cwd === undefined
        ? await ctx.db
            .query("threads")
            .withIndex("by_instance_and_thread", (q) => q.eq("instance", args.instance))
            .take(32_000)
        : await ctx.db
            .query("threads")
            .withIndex("by_instance_and_cwd_and_createdAt", (q) => q.eq("instance", args.instance).eq("cwd", args.cwd))
            .take(32_000);
    return {
      ok: true as const,
      value: rows.map((row) => ({
        threadId: row.thread,
        filePath: row.filePath,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        createdAt: row.createdAt,
      })),
    };
  },
});

export const info = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    return {
      ok: true as const,
      value: { threadId: resolved.thread.thread, createdAt: resolved.thread.createdAt },
    };
  },
});
