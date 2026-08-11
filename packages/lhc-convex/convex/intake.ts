import { v } from "convex/values";
import type { MessageEventInput } from "../src/client/types.js";
import { validateEvents, validateThreadRef } from "../src/shared/intake_validate.js";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { mutation, query } from "./_generated/server.js";
import { callerError, enqueueWork, nowIso, type QueueCursor, resolveThread, upsertInstance } from "./common.js";
import { scheduleDrain } from "./queue.js";

function projection(kind: string, payload: Record<string, unknown>) {
  switch (kind) {
    case "user_prompt":
    case "runtime_note": {
      const text = String(payload["text"] ?? "");
      return { blockType: "text", content: { text }, tokens: estimateTokens(text) };
    }
    case "assistant_text": {
      // Verbatim payload copy: text always; model identity when the host sent
      // it (pin 795da41 — resume keeps signed thinking only under an exact
      // identity match, so identity is frozen at capture).
      const text = String(payload["text"] ?? "");
      const content: Record<string, unknown> = { text };
      for (const field of ["provider", "model", "api"] as const) {
        if (payload[field] !== undefined) content[field] = payload[field];
      }
      return { blockType: "text", content, tokens: estimateTokens(text) };
    }
    case "assistant_thinking": {
      // Verbatim payload copy: text always; signature + model identity when
      // sent (pin d0f00bb / 795da41). Signature bytes count toward the
      // estimate — served back to the provider they sit in the live context
      // window (the fable live-vs-LHC token gap).
      const text = String(payload["text"] ?? "");
      const content: Record<string, unknown> = { text };
      if (payload["signature"] !== undefined) content["signature"] = payload["signature"];
      for (const field of ["provider", "model", "api"] as const) {
        if (payload[field] !== undefined) content[field] = payload[field];
      }
      const signature = typeof payload["signature"] === "string" ? payload["signature"] : "";
      const estimateSource = signature !== "" ? `${text}${signature}` : text;
      return { blockType: "text", content, tokens: estimateTokens(estimateSource) };
    }
    case "model_change": {
      const previousModel = String(payload["previousModel"] ?? "");
      const newModel = String(payload["newModel"] ?? "");
      return {
        blockType: "model_change",
        content: { previousModel, newModel },
        tokens: estimateTokens(`${previousModel} ${newModel}`),
      };
    }
    case "thinking_level_change": {
      const previousLevel = String(payload["previousLevel"] ?? "");
      const newLevel = String(payload["newLevel"] ?? "");
      return {
        blockType: "thinking_level_change",
        content: { previousLevel, newLevel },
        tokens: estimateTokens(`${previousLevel} ${newLevel}`),
      };
    }
    case "tool_call": {
      const content = {
        toolCallId: String(payload["toolCallId"] ?? ""),
        toolName: String(payload["toolName"] ?? ""),
        arguments:
          typeof payload["arguments"] === "object" && payload["arguments"] !== null ? payload["arguments"] : {},
      };
      return { blockType: "tool_call", content, tokens: estimateTokens(JSON.stringify(content.arguments)) };
    }
    case "tool_result": {
      const content = {
        toolCallId: String(payload["toolCallId"] ?? ""),
        content: String(payload["content"] ?? ""),
        isError: payload["isError"] === true,
      };
      return { blockType: "tool_result", content, tokens: estimateTokens(content.content) };
    }
    default:
      return null;
  }
}

export const messageEvents = mutation({
  args: {
    instance: v.string(),
    config: v.any(),
    modelCallHandle: v.string(),
    ref: v.any(),
    events: v.any(),
  },
  handler: async (ctx, args) => {
    const invalidRef = validateThreadRef(args.ref);
    if (invalidRef !== undefined) return { ok: false as const, error: invalidRef };
    const invalidEvents = validateEvents(args.events);
    if (invalidEvents !== undefined) return { ok: false as const, error: invalidEvents };
    const events = args.events as MessageEventInput[];
    const instance = await upsertInstance(ctx, args);
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const thread = resolved.thread;
    const openTurns = await ctx.db
      .query("turns")
      .withIndex("by_instance_and_thread_and_status", (q) =>
        q.eq("instance", args.instance).eq("thread", thread.thread).eq("status", "open"),
      )
      .take(2);
    if (openTurns.length !== 1) {
      return callerError(
        "turn_state_corrupt",
        `thread has ${openTurns.length} open turns; the invariant is exactly one`,
      );
    }
    let currentTurn = openTurns[0]!;
    let eventOrder = thread.nextEventOrder;
    let turnOrder = thread.nextTurnOrder;
    const queue: QueueCursor = { next: thread.nextWorkSequence };
    const eventReceipts: Array<Record<string, unknown>> = [];
    const turnTransitions: Array<{ action: "opened" | "closed"; turnId: string }> = [];
    const queuedWork: Array<Record<string, unknown>> = [];

    for (const event of events) {
      const duplicate = await ctx.db
        .query("events")
        .withIndex("by_instance_and_thread_and_idemKey", (q) =>
          q.eq("instance", args.instance).eq("thread", thread.thread).eq("idemKey", event.idempotencyKey),
        )
        .unique();
      if (duplicate !== null) {
        eventReceipts.push({
          idempotencyKey: event.idempotencyKey,
          outcome: "skipped",
          skipReason: "duplicate_idempotency_key",
        });
        continue;
      }

      const recordedAt = nowIso();
      await ctx.db.insert("events", {
        instance: args.instance,
        thread: thread.thread,
        eventOrder,
        eventKind: event.eventKind,
        idemKey: event.idempotencyKey,
        actor: event.actor,
        harness: event.harness,
        payload: event.payload,
        recordedAt,
      });

      const members = await ctx.db
        .query("messages")
        .withIndex("by_instance_and_thread_and_turn_and_deletedAt_and_sourceOrder", (q) =>
          q
            .eq("instance", args.instance)
            .eq("thread", thread.thread)
            .eq("turn", currentTurn.turn)
            .eq("deletedAt", undefined),
        )
        .take(1);
      const closesTurn = members.length > 0 && (event.eventKind === "turn_end" || event.eventKind === "user_prompt");
      if (closesTurn) {
        // Host facts project only from turn_end. Prompt-boundary closes and
        // empty turn_end leave the optional fields absent (D1, D2, D4).
        const closePatch: {
          status: "closed";
          closedAtEventOrder: number;
          outcome?: "completed" | "aborted";
          outcomeReason?: string;
          startedAt?: string;
          endedAt?: string;
        } = { status: "closed", closedAtEventOrder: eventOrder };
        if (event.eventKind === "turn_end") {
          const hostFacts = event.payload as {
            outcome?: "completed" | "aborted";
            outcomeReason?: string;
            startedAt?: string;
            endedAt?: string;
          };
          if (hostFacts.outcome !== undefined) closePatch.outcome = hostFacts.outcome;
          if (hostFacts.outcomeReason !== undefined) closePatch.outcomeReason = hostFacts.outcomeReason;
          if (hostFacts.startedAt !== undefined) closePatch.startedAt = hostFacts.startedAt;
          if (hostFacts.endedAt !== undefined) closePatch.endedAt = hostFacts.endedAt;
        }
        await ctx.db.patch("turns", currentTurn._id, closePatch);
        turnTransitions.push({ action: "closed", turnId: currentTurn.turn });
        queuedWork.push(
          await enqueueWork(ctx, thread, queue, {
            owner: "turns",
            kind: "turn_derivation",
            sourceRef: { turnId: currentTurn.turn },
            derivations: [
              { scope: "turn", subject: currentTurn.turn, deriv: "turn_rendering" },
              { scope: "turn", subject: currentTurn.turn, deriv: "pre_detailed_assembly" },
            ],
          }),
        );
        const nextTurn = `t${turnOrder}`;
        const nextTurnId = await ctx.db.insert("turns", {
          instance: args.instance,
          thread: thread.thread,
          turn: nextTurn,
          turnOrder,
          status: "open",
          openedAtEventOrder: eventOrder,
        });
        currentTurn = (await ctx.db.get("turns", nextTurnId))!;
        turnOrder += 1;
        turnTransitions.push({ action: "opened", turnId: nextTurn });
      }

      const projected = projection(event.eventKind, event.payload as Record<string, unknown>);
      if (projected === null) {
        eventReceipts.push({ idempotencyKey: event.idempotencyKey, outcome: "recorded" });
      } else {
        const messageId = `m${eventOrder}`;
        // providerUsage rides assistant_text only; omit the key when absent
        // (exactOptionalPropertyTypes / D3 — no invented null).
        const messageRow: {
          instance: string;
          thread: string;
          message: string;
          sourceOrder: number;
          kind: string;
          tokenEstimate: number;
          actor: string;
          harness: string;
          turn: string;
          recordedAt: string;
          providerUsage?: Record<string, unknown>;
        } = {
          instance: args.instance,
          thread: thread.thread,
          message: messageId,
          sourceOrder: eventOrder,
          kind: event.eventKind,
          tokenEstimate: projected.tokens,
          actor: event.actor,
          harness: event.harness,
          turn: currentTurn.turn,
          recordedAt,
        };
        if (
          event.eventKind === "assistant_text" &&
          (event.payload as { providerUsage?: Record<string, unknown> }).providerUsage !== undefined
        ) {
          messageRow.providerUsage = (event.payload as { providerUsage: Record<string, unknown> }).providerUsage;
        }
        await ctx.db.insert("messages", messageRow);
        await ctx.db.insert("messageBlocks", {
          instance: args.instance,
          thread: thread.thread,
          message: messageId,
          blockIndex: 0,
          blockType: projected.blockType,
          content: projected.content,
        });
        if (event.eventKind === "user_prompt") {
          queuedWork.push(
            await enqueueWork(ctx, thread, queue, {
              owner: "messages",
              kind: "prompt_smoothing",
              sourceRef: { messageId },
              derivations: [{ scope: "message", subject: messageId, deriv: "smoothed_prompt" }],
            }),
          );
        } else if (event.eventKind === "tool_result") {
          queuedWork.push(
            await enqueueWork(ctx, thread, queue, {
              owner: "messages",
              kind: "tool_result_summary",
              sourceRef: { messageId },
              derivations: [{ scope: "message", subject: messageId, deriv: "tool_result_summary" }],
            }),
          );
        }
        eventReceipts.push({ idempotencyKey: event.idempotencyKey, outcome: "recorded", messageId });
      }
      eventOrder += 1;
    }

    await ctx.db.patch("threads", thread._id, {
      nextEventOrder: eventOrder,
      nextTurnOrder: turnOrder,
      nextWorkSequence: queue.next,
    });
    if ((instance.config as { mode?: string }).mode === "background" && queuedWork.length > 0) {
      const refreshed = await ctx.db.get("threads", thread._id);
      if (refreshed !== null) await scheduleDrain(ctx, refreshed);
    }
    return {
      ok: true as const,
      value: {
        events: eventReceipts,
        turnTransitions,
        queuedWork,
        threadPosition: { lastEventOrder: Math.max(0, eventOrder - 1) },
      },
    };
  },
});

export const listEvents = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const rows = await ctx.db
      .query("events")
      .withIndex("by_instance_and_thread_and_eventOrder", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread),
      )
      .take(32_000);
    return {
      ok: true as const,
      value: rows.map((row) => ({
        eventKind: row.eventKind,
        idempotencyKey: row.idemKey,
        actor: row.actor,
        harness: row.harness,
        payload: row.payload,
        eventOrder: row.eventOrder,
        recordedAt: row.recordedAt,
      })),
    };
  },
});
