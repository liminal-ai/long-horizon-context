import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import type { ModelCallInput, ModelCallResult } from "../src/client/types.js";
import { classifyToolResult } from "../src/shared/classify_tool_result.js";
import { safeModelCall } from "../src/shared/model_call.js";
import { PROMPT_REGISTRY, type PromptTemplate } from "../src/shared/prompts/index.js";
import { cleanPrompt } from "../src/shared/smoothing.js";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import { truncateForFallback } from "../src/shared/tool_result_rendering.js";
import { toolResultTargetTokens } from "../src/shared/tool_result_summary.js";
import {
  composeDerivationKey,
  composePreDetailedAssembly,
  composeRenderingInput,
  type RecoveryReceipt,
} from "../src/shared/turn_compose.js";
import type { RenderingPart, RenderingPartKind } from "../src/client/types.js";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import {
  enqueueWork,
  nowIso,
  type QueueCursor,
  readInstance,
  resolveThread,
  type StoredConfig,
  type ThreadDoc,
} from "./common.js";

const REAP_AFTER_MS = 60_000;

/**
 * A live recorded drain has not yet passed its exit gate (drainExit clears or
 * replaces the id there, in a mutation serialized before the action turns
 * terminal), so skipping is safe: the gate re-checks the queue. A recorded
 * drain observed terminal died before its gate — its "running" items are dead
 * one-shot work (fail them, never re-run them) and a fresh drain starts. The
 * reaper covers the same death without any later enqueue to observe it.
 */
export async function scheduleDrain(ctx: MutationCtx, thread: ThreadDoc): Promise<boolean> {
  if (thread.scheduledDrainId !== undefined) {
    const scheduled = await ctx.db.system.get("_scheduled_functions", thread.scheduledDrainId);
    const kind = scheduled?.state.kind;
    if (kind === "pending" || kind === "inProgress") return false;
    await failAbandonedRunning(ctx, thread.instance, thread.thread);
  }
  await startDrain(ctx, thread._id, thread.instance, thread.thread);
  return true;
}

async function startDrain(
  ctx: MutationCtx,
  threadDocId: ThreadDoc["_id"],
  instance: string,
  thread: string,
): Promise<void> {
  const scheduledDrainId = await ctx.scheduler.runAfter(0, internal.queue.drainLoop, {
    instance,
    thread,
  });
  await ctx.scheduler.runAfter(REAP_AFTER_MS, internal.queue.reapDrain, {
    instance,
    thread,
    drain: scheduledDrainId,
  });
  await ctx.db.patch("threads", threadDocId, { scheduledDrainId });
}

/**
 * Exactly-once watchdog over one drain (scheduled mutations retry; actions do
 * not). A drain that reaches a terminal state while still recorded died before
 * its exit gate: fail its abandoned running work, restart iff work remains
 * queued, stand down otherwise. Terminal work becomes visibly failed and never
 * gates, with no dependence on a future enqueue or touch.
 */
export const reapDrain = internalMutation({
  args: { instance: v.string(), thread: v.string(), drain: v.id("_scheduled_functions") },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_instance_and_thread", (q) =>
        q.eq("instance", args.instance).eq("thread", args.thread),
      )
      .unique();
    if (thread === null || thread.scheduledDrainId !== args.drain) {
      return { outcome: "superseded" as const };
    }
    const scheduled = await ctx.db.system.get("_scheduled_functions", args.drain);
    const kind = scheduled?.state.kind;
    if (kind === "pending" || kind === "inProgress") {
      await ctx.scheduler.runAfter(REAP_AFTER_MS, internal.queue.reapDrain, args);
      return { outcome: "watching" as const };
    }
    await failAbandonedRunning(ctx, args.instance, args.thread);
    const queued = await ctx.db
      .query("workItems")
      .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", args.thread).eq("status", "queued"),
      )
      .first();
    if (queued !== null) {
      await startDrain(ctx, thread._id, args.instance, args.thread);
      return { outcome: "restarted" as const };
    }
    await ctx.db.patch("threads", thread._id, { scheduledDrainId: undefined });
    return { outcome: "swept" as const };
  },
});

async function failAbandonedRunning(
  ctx: MutationCtx,
  instance: string,
  thread: string,
): Promise<void> {
  const abandoned = await ctx.db
    .query("workItems")
    .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("status", "running"),
    )
    .take(32_000);
  if (abandoned.length === 0) return;
  const timestamp = nowIso();
  const lastLog = await ctx.db
    .query("logs")
    .withIndex("by_instance_and_thread_and_seq", (q) => q.eq("instance", instance).eq("thread", thread))
    .order("desc")
    .first();
  let logSeq = (lastLog?.seq ?? 0) + 1;
  for (const item of abandoned) {
    for (const target of item.derivs) {
      const row = await ctx.db
        .query("derivations")
        .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
          q
            .eq("instance", instance)
            .eq("thread", thread)
            .eq("scope", target.scope)
            .eq("subject", target.subject)
            .eq("deriv", target.deriv),
        )
        .unique();
      if (row !== null && row.sourceVersion === item.sourceVersion && row.state !== "ready") {
        await ctx.db.patch("derivations", row._id, {
          state: "failed",
          reason: "drain died while the item was running",
          content: undefined,
          derivedAt: timestamp,
        });
      }
      await ctx.db.insert("logs", {
        instance,
        thread,
        seq: logSeq,
        level: "warning",
        message: "running work item abandoned by a dead drain; marked failed",
        deriv: target.deriv,
        subject: target.subject,
        recordedAt: timestamp,
      });
      logSeq += 1;
    }
    await ctx.db.delete("workItems", item._id);
  }
}

export const claim = internalMutation({
  args: { instance: v.string(), thread: v.string() },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("workItems")
      .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", args.thread).eq("status", "queued"),
      )
      .first();
    if (item === null) return null;
    await ctx.db.patch("workItems", item._id, { status: "running", startedAt: nowIso() });
    const instance = await readInstance(ctx.db, args.instance);
    if (instance === null) throw new Error(`component instance ${args.instance} disappeared`);
    return { item: { ...item, status: "running" as const, startedAt: nowIso() }, instance };
  },
});

export const resolveRef = internalQuery({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    return resolved.ok ? { ok: true as const, thread: resolved.thread.thread } : resolved;
  },
});

export const readSource = internalQuery({
  args: {
    instance: v.string(),
    thread: v.string(),
    kind: v.string(),
    sourceRef: v.any(),
  },
  handler: async (ctx, args) => {
    const sourceRef = args.sourceRef as Record<string, string>;
    if (args.kind === "prompt_smoothing" || args.kind === "tool_result_summary") {
      const messageId = sourceRef["messageId"];
      if (messageId === undefined) return { damaged: "work item carries no messageId" };
      const message = await ctx.db
        .query("messages")
        .withIndex("by_instance_and_thread_and_message", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("message", messageId),
        )
        .unique();
      if (message === null || message.deletedAt !== undefined) return { damaged: `message ${messageId} not found` };
      const blocks = await ctx.db
        .query("messageBlocks")
        .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("message", messageId),
        )
        .take(100);
      if (args.kind !== "tool_result_summary") return { message, blocks };
      const resultBlock = blocks.find((block) => block.blockType === "tool_result");
      const resultContent = resultBlock?.content as Record<string, unknown> | undefined;
      const toolCallId = resultContent?.["toolCallId"];
      if (typeof toolCallId !== "string") return { message, blocks };
      const threadBlocks = await ctx.db
        .query("messageBlocks")
        .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread),
        )
        .take(32_000);
      const callBlock = threadBlocks.find((block) => {
        if (block.blockType !== "tool_call") return false;
        const content = block.content as Record<string, unknown>;
        return content["toolCallId"] === toolCallId;
      });
      if (callBlock === undefined) return { message, blocks };
      const callMessage = await ctx.db
        .query("messages")
        .withIndex("by_instance_and_thread_and_message", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("message", callBlock.message),
        )
        .unique();
      if (callMessage === null || callMessage.deletedAt !== undefined) return { message, blocks };
      const callContent = callBlock.content as Record<string, unknown>;
      return {
        message,
        blocks,
        pairedCall: {
          toolName: typeof callContent["toolName"] === "string" ? callContent["toolName"] : "unknown_tool",
          ...(typeof callContent["arguments"] === "object" && callContent["arguments"] !== null
            ? { toolInput: callContent["arguments"] as Record<string, unknown> }
            : {}),
        },
      };
    }
    if (args.kind === "turn_derivation" || args.kind === "detailed_turn_compression") {
      const turnId = sourceRef["turnId"];
      if (turnId === undefined) return { damaged: "work item carries no turnId" };
      const turn = await ctx.db
        .query("turns")
        .withIndex("by_instance_and_thread_and_turn", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("turn", turnId),
        )
        .unique();
      if (turn === null || turn.deletedAt !== undefined) return { damaged: `turn ${turnId} not found` };
      if (args.kind === "detailed_turn_compression") {
        const assembly = await ctx.db
          .query("derivations")
          .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
            q
              .eq("instance", args.instance)
              .eq("thread", args.thread)
              .eq("scope", "turn")
              .eq("subject", turnId)
              .eq("deriv", "pre_detailed_assembly"),
          )
          .unique();
        return { turn, assembly };
      }
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_instance_and_thread_and_turn_and_deletedAt_and_sourceOrder", (q) =>
          q
            .eq("instance", args.instance)
            .eq("thread", args.thread)
            .eq("turn", turnId)
            .eq("deletedAt", undefined),
        )
        .take(32_000);
      const material = [];
      for (const message of messages) {
        const blocks = await ctx.db
          .query("messageBlocks")
          .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
            q.eq("instance", args.instance).eq("thread", args.thread).eq("message", message.message),
          )
          .take(100);
        const derivations = await ctx.db
          .query("derivations")
          .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
            q
              .eq("instance", args.instance)
              .eq("thread", args.thread)
              .eq("scope", "message")
              .eq("subject", message.message),
          )
          .take(100);
        material.push({ message, blocks, derivations });
      }
      return { turn, material };
    }
    if (args.kind === "chunk_summary_detailed" || args.kind === "chunk_summary_brief") {
      const chunkId = sourceRef["chunkId"];
      if (chunkId === undefined) return { damaged: "work item carries no chunkId" };
      const chunk = await ctx.db
        .query("chunks")
        .withIndex("by_instance_and_thread_and_chunk", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("chunk", chunkId),
        )
        .unique();
      if (chunk === null) return { damaged: `chunk ${chunkId} not found` };
      if (args.kind === "chunk_summary_brief") {
        const detailed = await ctx.db
          .query("derivations")
          .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
            q
              .eq("instance", args.instance)
              .eq("thread", args.thread)
              .eq("scope", "chunk")
              .eq("subject", chunkId)
              .eq("deriv", "chunk_summary_detailed"),
          )
          .unique();
        return { chunk, detailed };
      }
      const members = await ctx.db
        .query("chunkMembers")
        .withIndex("by_instance_and_thread_and_chunk_and_memberIdx", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("chunk", chunkId),
        )
        .take(32_000);
      const projections = [];
      for (const member of members) {
        const rows = await ctx.db
          .query("derivations")
          .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
            q.eq("instance", args.instance).eq("thread", args.thread).eq("scope", "turn").eq("subject", member.turn),
          )
          .take(100);
        projections.push({ turnId: member.turn, derivations: rows });
      }
      return { chunk, projections };
    }
    return { damaged: `unknown work kind ${args.kind}` };
  },
});

interface DerivationWrite {
  scope: "message" | "turn" | "chunk";
  subject: string;
  deriv: string;
  content: string;
  metadata?: Record<string, unknown>;
  gaps?: unknown[];
}

interface HandlerResult {
  state: "ready" | "failed" | "blocked";
  reason?: string;
  writes?: DerivationWrite[];
  recoveries?: RecoveryReceipt[];
  derivationLogs?: Array<{
    scope: "message" | "turn" | "chunk";
    subject: string;
    deriv: string;
    eventKind: string;
    payload: Record<string, unknown>;
  }>;
  logs?: Array<{
    level: "info" | "warning" | "error";
    message: string;
    deriv?: string;
    subject?: string;
    reason?: string;
    floorUsed?: string;
  }>;
  projectedTokens?: number;
}

function blockContent(source: Record<string, unknown>): Record<string, unknown> {
  const blocks = source["blocks"] as Array<{ content: Record<string, unknown> }> | undefined;
  return blocks?.[0]?.content ?? {};
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
    .map((part) => {
      const annotations = [
        part.fallback ? "fallback" : undefined,
        part.outcome === undefined ? undefined : `outcome: ${part.outcome}`,
      ].filter((annotation): annotation is string => annotation !== undefined);
      const suffix = annotations.length === 0 ? "" : ` [${annotations.join("; ")}]`;
      return `${renderingPartLabel(part.kind)}${suffix}\n${part.text}`;
    })
    .join("\n\n");
}

function boundContent(content: string, maxInputChars: number): string {
  if (content.length <= maxInputChars) return content;
  const marker = `\n\n[... truncated: tool result was ${String(content.length)} chars; head and tail retained ...]\n\n`;
  if (marker.length > maxInputChars) return content.slice(0, maxInputChars);
  const keep = maxInputChars - marker.length;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return content.slice(0, head) + marker + (tail > 0 ? content.slice(content.length - tail) : "");
}

async function callModel(
  ctx: ActionCtx,
  instance: Doc<"instances">,
  derivationType: string,
  input: unknown,
): Promise<
  | {
      ok: true;
      text: string;
      metadata: Record<string, unknown>;
      requestMessages: ModelCallInput["messages"];
      rawResponse: string;
    }
  | { ok: false; reason: string; requestMessages?: ModelCallInput["messages"] }
> {
  const config = instance.config as StoredConfig;
  const assignment = config.assignments[derivationType];
  if (assignment === undefined) return { ok: false, reason: `invalid_request: no assignment for ${derivationType}` };
  const template = PROMPT_REGISTRY[assignment.prompt] as PromptTemplate<unknown> | undefined;
  if (template === undefined)
    return { ok: false, reason: `invalid_request: prompt template ${assignment.prompt} not found` };
  const messages = template.render(input);
  const handle = instance.modelCallHandle as FunctionHandle<"action", ModelCallInput, ModelCallResult>;
  const result = await safeModelCall(
    () =>
      ctx.runAction(handle, {
        provider: assignment.provider,
        model: assignment.model,
        messages,
        ...(assignment.thinking === undefined ? {} : { thinking: assignment.thinking }),
      }),
    config.timeoutMs,
  );
  if (!result.ok) {
    const detail = result.message === "" ? result.kind : `${result.kind}: ${result.message}`;
    return {
      ok: false,
      reason: result.kind === "auth" || result.kind === "invalid_request" ? detail : `provider_failure: ${detail}`,
      requestMessages: messages,
    };
  }
  const text = result.text.trim();
  if (text === "") {
    return {
      ok: false,
      reason: "provider_failure: empty_output: model returned no text",
      requestMessages: messages,
    };
  }
  return {
    ok: true,
    text,
    metadata: {
      inferenceAttempted: true,
      inferenceSucceeded: true,
      provenance: { provider: assignment.provider, model: assignment.model, prompt: assignment.prompt },
    },
    requestMessages: messages,
    rawResponse: result.text,
  };
}

async function handleWork(
  ctx: ActionCtx,
  claimed: { item: Doc<"workItems">; instance: Doc<"instances"> },
  source: Record<string, unknown>,
): Promise<HandlerResult> {
  const { item, instance } = claimed;
  if (typeof source["damaged"] === "string")
    return { state: "blocked", reason: `source_damaged: ${source["damaged"]}` };
  const config = instance.config as StoredConfig;
  if (item.kind === "prompt_smoothing") {
    const message = source["message"] as Doc<"messages">;
    if (message.kind !== "user_prompt") return { state: "blocked", reason: `source_damaged: expected user_prompt` };
    const sourceText = blockContent(source)["text"];
    if (typeof sourceText !== "string") {
      return { state: "blocked", reason: `source_damaged: prompt ${message.message} has no text block` };
    }
    const text = sourceText;
    const cleaned = cleanPrompt(text);
    const tokens = estimateTokens(cleaned);
    if (/^\[[^\]]{1,80}\]$/.test(cleaned.trim()) || tokens > config.guards.smoothedPrompt.maxInferenceTokens) {
      return {
        state: "ready",
        writes: [{ scope: "message", subject: message.message, deriv: "smoothed_prompt", content: cleaned }],
      };
    }
    const inference = await callModel(ctx, instance, "smoothed_prompt", { text: cleaned });
    if (!inference.ok) {
      return {
        state: "failed",
        reason: inference.reason,
        derivationLogs: [
          {
            scope: "message",
            subject: message.message,
            deriv: "smoothed_prompt",
            eventKind: "inference_failed",
            payload: {
              reason: inference.reason,
              ...(inference.requestMessages === undefined ? {} : { requestMessages: inference.requestMessages }),
            },
          },
        ],
      };
    }
    const suspicious = estimateTokens(inference.text) < config.guards.smoothedPrompt.suspiciousOutputRatio * tokens;
    return {
      state: "ready",
      writes: [
        {
          scope: "message",
          subject: message.message,
          deriv: "smoothed_prompt",
          content: suspicious ? cleaned : inference.text,
          metadata: suspicious ? { discardReason: "suspicious_output_ratio" } : inference.metadata,
        },
      ],
    };
  }
  if (item.kind === "tool_result_summary") {
    const message = source["message"] as Doc<"messages">;
    if (message.kind !== "tool_result") return { state: "blocked", reason: "source_damaged: expected tool_result" };
    const block = blockContent(source);
    const content = block["content"];
    if (typeof content !== "string") {
      return { state: "blocked", reason: `source_damaged: tool result ${message.message} has no tool_result block` };
    }
    const outcome = block["isError"] === true ? "failed" : "succeeded";
    if (outcome === "failed") {
      return {
        state: "ready",
        writes: [
          {
            scope: "message",
            subject: message.message,
            deriv: "tool_result_summary",
            content: truncateForFallback(content),
            metadata: { outcome },
          },
        ],
      };
    }
    const tokens = estimateTokens(content);
    if (tokens <= config.toolResult.smallTierTokens) {
      return {
        state: "ready",
        writes: [
          {
            scope: "message",
            subject: message.message,
            deriv: "tool_result_summary",
            content,
            metadata: { outcome },
          },
        ],
      };
    }
    const pairedCall = source["pairedCall"] as
      | { toolName: string; toolInput?: Record<string, unknown> }
      | undefined;
    const classification = classifyToolResult({
      toolName: pairedCall?.toolName ?? "unknown_tool",
      ...(pairedCall?.toolInput === undefined ? {} : { toolInput: pairedCall.toolInput }),
      rawOutput: content,
      outcome,
    });
    const inference = await callModel(ctx, instance, "tool_result_summary", {
      toolName: pairedCall?.toolName ?? "unknown_tool",
      content: boundContent(content, config.maxInputChars),
      outcome,
      targetTokens: toolResultTargetTokens(tokens, config.toolResult),
      operationClass: classification.operationClass,
      responseShape: classification.responseShape,
      promptMode: classification.promptMode,
      facts: classification.facts,
    });
    if (!inference.ok) {
      return {
        state: "ready",
        writes: [
          {
            scope: "message",
            subject: message.message,
            deriv: "tool_result_summary",
            content: truncateForFallback(content),
            metadata: {
              outcome,
              inferenceAttempted: true,
              inferenceSucceeded: false,
              fallbackUsed: true,
              fallbackFloor: "deterministic_truncation",
              lastError: inference.reason,
            },
          },
        ],
        derivationLogs: [
          {
            scope: "message",
            subject: message.message,
            deriv: "tool_result_summary",
            eventKind: "inference_failed",
            payload: {
              reason: inference.reason,
              ...(inference.requestMessages === undefined ? {} : { requestMessages: inference.requestMessages }),
            },
          },
        ],
      };
    }
    return {
      state: "ready",
      writes: [
        {
          scope: "message",
          subject: message.message,
          deriv: "tool_result_summary",
          content: inference.text,
          metadata: { outcome, ...inference.metadata },
        },
      ],
      derivationLogs: [
        {
          scope: "message",
          subject: message.message,
          deriv: "tool_result_summary",
          eventKind: "inference_succeeded",
          payload: {
            provenance: inference.metadata["provenance"],
            requestMessages: inference.requestMessages,
            rawResponse: inference.rawResponse,
          },
        },
      ],
    };
  }
  if (item.kind === "turn_derivation") {
    const turn = source["turn"] as Doc<"turns">;
    if (turn.status !== "closed") return { state: "blocked", reason: `source_damaged: turn ${turn.turn} is open` };
    const material = source["material"] as Array<{
      message: Doc<"messages">;
      blocks: Array<Doc<"messageBlocks">>;
      derivations: Array<Doc<"derivations">>;
    }>;
    const messages = material.map((member) => ({
      messageId: member.message.message,
      kind: member.message.kind as RenderingPartKind,
      blocks: member.blocks.map((block) => ({
        blockType: block.blockType,
        content: block.content as Record<string, unknown>,
      })),
    }));
    const derivations = new Map();
    for (const member of material) {
      for (const row of member.derivations) {
        derivations.set(composeDerivationKey(member.message.message, row.deriv), {
          state: row.state,
          sourceVersion: row.sourceVersion,
          ...(row.content === undefined ? {} : { content: row.content }),
          ...(row.reason === undefined ? {} : { reason: row.reason }),
          ...(row.metadata === undefined ? {} : { metadata: row.metadata }),
        });
      }
    }
    const rendering = composeRenderingInput(messages, derivations);
    const assembly = composePreDetailedAssembly(messages, derivations);
    const recoveries = new Map<string, RecoveryReceipt>();
    for (const recovery of [...rendering.recoveries, ...assembly.recoveries]) {
      recoveries.set(`${recovery.subjectId}:${recovery.derivationType}`, recovery);
    }
    return {
      state: "ready",
      projectedTokens: estimateTokens(assembly.text),
      recoveries: [...recoveries.values()],
      writes: [
        {
          scope: "turn",
          subject: turn.turn,
          deriv: "turn_rendering",
          content: composeStructuredTurnText(rendering.parts),
          gaps: rendering.gaps,
        },
        {
          scope: "turn",
          subject: turn.turn,
          deriv: "pre_detailed_assembly",
          content: assembly.text,
          gaps: assembly.gaps,
        },
      ],
    };
  }
  if (item.kind === "detailed_turn_compression") {
    const turn = source["turn"] as Doc<"turns">;
    const assembly = source["assembly"] as Doc<"derivations"> | null;
    if (assembly === null || assembly.state !== "ready" || assembly.content === undefined) {
      return { state: "failed", reason: `pre_detailed_assembly_not_ready: turn ${turn.turn}` };
    }
    const inputTokens = estimateTokens(assembly.content);
    if (inputTokens < config.guards.detailedTurnCompression.tinyTurnTokens) {
      return {
        state: "ready",
        writes: [{ scope: "turn", subject: turn.turn, deriv: "detailed_turn_compression", content: assembly.content }],
      };
    }
    const assignment = config.assignments["detailed_turn_compression"];
    const input = {
      dialogueText: assembly.content,
      inputTokens,
      targetMinTokens: Math.max(1, Math.round(inputTokens * (assignment?.targetMinRatio ?? 0.35))),
      targetAimTokens: Math.max(1, Math.round(inputTokens * (assignment?.targetAimRatio ?? 0.5))),
      targetMaxTokens: Math.max(1, Math.round(inputTokens * (assignment?.targetMaxRatio ?? 0.65))),
    };
    const inference = await callModel(ctx, instance, "detailed_turn_compression", input);
    const sizeDisposition = inference.ok
      ? estimateTokens(inference.text) < input.targetMinTokens
        ? "under_min"
        : estimateTokens(inference.text) > input.targetMaxTokens
          ? "over_max"
          : "in_range"
      : undefined;
    const derivationLogs = inference.ok
      ? [
          {
            scope: "turn" as const,
            subject: turn.turn,
            deriv: "detailed_turn_compression",
            eventKind: "inference_succeeded",
            payload: {
              provenance: inference.metadata["provenance"],
              requestMessages: inference.requestMessages,
              rawResponse: inference.rawResponse,
            },
          },
        ]
      : [
          {
            scope: "turn" as const,
            subject: turn.turn,
            deriv: "detailed_turn_compression",
            eventKind: "inference_failed",
            payload: {
              reason: inference.reason,
              ...(inference.requestMessages === undefined ? {} : { requestMessages: inference.requestMessages }),
            },
          },
          {
            scope: "turn" as const,
            subject: turn.turn,
            deriv: "detailed_turn_compression",
            eventKind: "fallback_applied",
            payload: { fallbackFloor: "pre_detailed_assembly", reason: inference.reason },
          },
        ];
    return {
      state: "ready",
      derivationLogs,
      ...(inference.ok
        ? {}
        : {
            logs: [
              {
                level: "warning" as const,
                message: "turn compression fallback used",
                deriv: "detailed_turn_compression",
                subject: turn.turn,
                reason: inference.reason,
                floorUsed: "pre_detailed_assembly",
              },
            ],
          }),
      writes: [
        {
          scope: "turn",
          subject: turn.turn,
          deriv: "detailed_turn_compression",
          content: inference.ok ? inference.text : assembly.content,
          metadata: inference.ok
            ? { ...inference.metadata, sizeDisposition }
            : {
                inferenceAttempted: true,
                inferenceSucceeded: false,
                fallbackUsed: true,
                fallbackFloor: "pre_detailed_assembly",
                lastError: inference.reason,
              },
        },
      ],
    };
  }
  if (item.kind === "chunk_summary_detailed") {
    const chunk = source["chunk"] as Doc<"chunks">;
    const projections = source["projections"] as Array<{ turnId: string; derivations: Array<Doc<"derivations">> }>;
    const sections: string[] = [];
    for (const member of projections) {
      const compression = member.derivations.find((row) => row.deriv === "detailed_turn_compression");
      const assembly = member.derivations.find((row) => row.deriv === "pre_detailed_assembly");
      if (compression?.state === "ready" && compression.content !== undefined) sections.push(compression.content);
      else if (compression?.state === "failed" && assembly?.state === "ready" && assembly.content !== undefined) {
        sections.push(assembly.content);
      } else {
        return { state: "failed", reason: `member_projection_not_ready: member ${member.turnId}` };
      }
    }
    return {
      state: "ready",
      writes: [
        { scope: "chunk", subject: chunk.chunk, deriv: "chunk_summary_detailed", content: sections.join("\n\n") },
      ],
    };
  }
  if (item.kind === "chunk_summary_brief") {
    const chunk = source["chunk"] as Doc<"chunks">;
    const detailed = source["detailed"] as Doc<"derivations"> | null;
    if (detailed === null || detailed.state !== "ready" || detailed.content === undefined) {
      return { state: "failed", reason: `chunk_summary_detailed_not_ready: chunk ${chunk.chunk}` };
    }
    const inputTokens = estimateTokens(detailed.content);
    const assignment = config.assignments["chunk_summary_brief"];
    const inference = await callModel(ctx, instance, "chunk_summary_brief", {
      text: detailed.content,
      inputTokens,
      targetMinTokens: Math.max(1, Math.round(inputTokens * (assignment?.targetMinRatio ?? 0.08))),
      targetAimTokens: Math.max(1, Math.round(inputTokens * (assignment?.targetAimRatio ?? 0.12))),
      targetMaxTokens: Math.max(1, Math.round(inputTokens * (assignment?.targetMaxRatio ?? 0.2))),
    });
    if (!inference.ok) {
      return {
        state: "failed",
        reason: inference.reason,
        derivationLogs: [
          {
            scope: "chunk",
            subject: chunk.chunk,
            deriv: "chunk_summary_brief",
            eventKind: "inference_failed",
            payload: {
              reason: inference.reason,
              ...(inference.requestMessages === undefined ? {} : { requestMessages: inference.requestMessages }),
            },
          },
        ],
      };
    }
    const outputTokens = estimateTokens(inference.text);
    const targetMinTokens = Math.max(1, Math.round(inputTokens * (assignment?.targetMinRatio ?? 0.08)));
    const targetMaxTokens = Math.max(1, Math.round(inputTokens * (assignment?.targetMaxRatio ?? 0.2)));
    const sizeDisposition =
      outputTokens < targetMinTokens ? "under_min" : outputTokens > targetMaxTokens ? "over_max" : "in_range";
    return {
      state: "ready",
      derivationLogs: [
        {
          scope: "chunk",
          subject: chunk.chunk,
          deriv: "chunk_summary_brief",
          eventKind: "inference_succeeded",
          payload: {
            provenance: inference.metadata["provenance"],
            requestMessages: inference.requestMessages,
            rawResponse: inference.rawResponse,
          },
        },
      ],
      writes: [
        {
          scope: "chunk",
          subject: chunk.chunk,
          deriv: "chunk_summary_brief",
          content: inference.text,
          metadata: { ...inference.metadata, sizeDisposition },
        },
      ],
    };
  }
  return { state: "blocked", reason: `unknown_work_kind: ${item.kind}` };
}

async function enqueueChunkSummaries(
  ctx: MutationCtx,
  thread: ThreadDoc,
  cursor: QueueCursor,
  chunkId: string,
): Promise<void> {
  for (const kind of ["chunk_summary_detailed", "chunk_summary_brief"] as const) {
    await enqueueWork(ctx, thread, cursor, {
      owner: "turns",
      kind,
      sourceRef: { chunkId },
      derivations: [{ scope: "chunk", subject: chunkId, deriv: kind }],
    });
  }
}

async function applyTurnPlacement(
  ctx: MutationCtx,
  thread: ThreadDoc,
  cursor: QueueCursor,
  turnId: string,
  projectedTokens: number,
  config: StoredConfig,
): Promise<number> {
  const existing = await ctx.db
    .query("chunkMembers")
    .withIndex("by_instance_and_thread_and_turn", (q) =>
      q.eq("instance", thread.instance).eq("thread", thread.thread).eq("turn", turnId),
    )
    .unique();
  if (existing !== null) return thread.nextChunkOrder;
  let nextChunkOrder = thread.nextChunkOrder;
  let open = await ctx.db
    .query("chunks")
    .withIndex("by_instance_and_thread_and_status", (q) =>
      q.eq("instance", thread.instance).eq("thread", thread.thread).eq("status", "open"),
    )
    .order("desc")
    .first();
  if (open !== null) {
    const members = await ctx.db
      .query("chunkMembers")
      .withIndex("by_instance_and_thread_and_chunk_and_memberIdx", (q) =>
        q.eq("instance", thread.instance).eq("thread", thread.thread).eq("chunk", open!.chunk),
      )
      .take(1);
    if (
      members.length > 0 &&
      open.accumulatedProjectedTokens + projectedTokens >= config.chunkPolicy.targetProjectedTokens
    ) {
      await ctx.db.patch("chunks", open._id, { status: "closed" });
      await enqueueChunkSummaries(ctx, thread, cursor, open.chunk);
      open = null;
    }
  }
  if (open === null) {
    const chunkId = `c${nextChunkOrder++}`;
    const id = await ctx.db.insert("chunks", {
      instance: thread.instance,
      thread: thread.thread,
      chunk: chunkId,
      chunkOrder: nextChunkOrder - 1,
      status: "open",
      accumulatedProjectedTokens: 0,
    });
    open = (await ctx.db.get("chunks", id))!;
  }
  const members = await ctx.db
    .query("chunkMembers")
    .withIndex("by_instance_and_thread_and_chunk_and_memberIdx", (q) =>
      q.eq("instance", thread.instance).eq("thread", thread.thread).eq("chunk", open!.chunk),
    )
    .take(32_000);
  await ctx.db.insert("chunkMembers", {
    instance: thread.instance,
    thread: thread.thread,
    chunk: open.chunk,
    turn: turnId,
    memberIdx: members.length,
  });
  await ctx.db.patch("chunks", open._id, {
    accumulatedProjectedTokens: open.accumulatedProjectedTokens + projectedTokens,
  });
  if (projectedTokens >= config.chunkPolicy.maxProjectedTokens) {
    await ctx.db.patch("chunks", open._id, { status: "closed" });
    await enqueueChunkSummaries(ctx, thread, cursor, open.chunk);
  }
  return nextChunkOrder;
}

export const complete = internalMutation({
  args: {
    instance: v.string(),
    thread: v.string(),
    workItem: v.string(),
    result: v.any(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("workItems")
      .withIndex("by_instance_and_thread_and_workItem", (q) =>
        q.eq("instance", args.instance).eq("thread", args.thread).eq("workItem", args.workItem),
      )
      .unique();
    if (item === null || item.status !== "running") return { disposition: "lost" as const };
    const result = args.result as HandlerResult;
    const timestamp = nowIso();
    const operatorLogs = [...(result.logs ?? [])];
    if (result.state === "ready") {
      for (const recovery of result.recoveries ?? []) {
        const row = await ctx.db
          .query("derivations")
          .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
            q
              .eq("instance", args.instance)
              .eq("thread", args.thread)
              .eq("scope", "message")
              .eq("subject", recovery.subjectId)
              .eq("deriv", recovery.derivationType),
          )
          .unique();
        if (row !== null && row.sourceVersion === recovery.sourceVersion && row.state !== "ready") {
          await ctx.db.patch("derivations", row._id, {
            state: "ready",
            content: recovery.content,
            reason: undefined,
            derivedAt: timestamp,
          });
          operatorLogs.push({
            level: "warning",
            message: "derivation fallback used",
            deriv: recovery.derivationType,
            subject: recovery.subjectId,
            reason: recovery.reason,
            floorUsed: recovery.floorUsed,
          });
        }
      }
      const writes = result.writes ?? [];
      for (const write of writes) {
        const row = await ctx.db
          .query("derivations")
          .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
            q
              .eq("instance", args.instance)
              .eq("thread", args.thread)
              .eq("scope", write.scope)
              .eq("subject", write.subject)
              .eq("deriv", write.deriv),
          )
          .unique();
        if (row === null || row.sourceVersion !== item.sourceVersion) {
          await ctx.db.delete("workItems", item._id);
          return { disposition: "stale" as const };
        }
        await ctx.db.patch("derivations", row._id, {
          state: "ready",
          content: write.content,
          reason: undefined,
          ...(write.metadata === undefined ? {} : { metadata: write.metadata }),
          ...(write.gaps === undefined ? {} : { gaps: write.gaps }),
          derivedAt: timestamp,
        });
      }
      if (item.kind === "turn_derivation") {
        const turnId = (item.sourceRef as Record<string, string>)["turnId"]!;
        const thread = await ctx.db
          .query("threads")
          .withIndex("by_instance_and_thread", (q) => q.eq("instance", args.instance).eq("thread", args.thread))
          .unique();
        const instance = await readInstance(ctx.db, args.instance);
        if (thread === null || instance === null) throw new Error("turn completion lost its owner rows");
        const cursor: QueueCursor = { next: thread.nextWorkSequence };
        await enqueueWork(ctx, thread, cursor, {
          owner: "turns",
          kind: "detailed_turn_compression",
          sourceRef: { turnId },
          sourceVersion: item.sourceVersion,
          derivations: [{ scope: "turn", subject: turnId, deriv: "detailed_turn_compression" }],
        });
        const nextChunkOrder = await applyTurnPlacement(
          ctx,
          thread,
          cursor,
          turnId,
          result.projectedTokens ?? 0,
          instance.config as StoredConfig,
        );
        await ctx.db.patch("threads", thread._id, {
          nextWorkSequence: cursor.next,
          nextChunkOrder,
        });
      }
    } else {
      for (const target of item.derivs) {
        const row = await ctx.db
          .query("derivations")
          .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
            q
              .eq("instance", args.instance)
              .eq("thread", args.thread)
              .eq("scope", target.scope)
              .eq("subject", target.subject)
              .eq("deriv", target.deriv),
          )
          .unique();
        if (row !== null && row.sourceVersion === item.sourceVersion) {
          await ctx.db.patch("derivations", row._id, {
            state: result.state,
            reason: result.reason ?? "unknown",
            content: undefined,
            derivedAt: timestamp,
          });
        }
      }
    }
    if ((result.derivationLogs?.length ?? 0) > 0) {
      const last = await ctx.db
        .query("derivationLogs")
        .withIndex("by_instance_and_thread_and_seq", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread),
        )
        .order("desc")
        .first();
      let seq = (last?.seq ?? 0) + 1;
      for (const entry of result.derivationLogs ?? []) {
        await ctx.db.insert("derivationLogs", {
          instance: args.instance,
          thread: args.thread,
          seq,
          scope: entry.scope,
          subject: entry.subject,
          deriv: entry.deriv,
          eventKind: entry.eventKind,
          payload: entry.payload,
          recordedAt: timestamp,
        });
        seq += 1;
      }
    }
    if (operatorLogs.length > 0) {
      const last = await ctx.db
        .query("logs")
        .withIndex("by_instance_and_thread_and_seq", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread),
        )
        .order("desc")
        .first();
      let seq = (last?.seq ?? 0) + 1;
      for (const entry of operatorLogs) {
        await ctx.db.insert("logs", {
          instance: args.instance,
          thread: args.thread,
          seq,
          level: entry.level,
          message: entry.message,
          ...(entry.deriv === undefined ? {} : { deriv: entry.deriv }),
          ...(entry.subject === undefined ? {} : { subject: entry.subject }),
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          ...(entry.floorUsed === undefined ? {} : { floorUsed: entry.floorUsed }),
          recordedAt: timestamp,
        });
        seq += 1;
      }
    }
    await ctx.db.delete("workItems", item._id);
    return { disposition: result.state === "ready" ? ("done" as const) : result.state };
  },
});

export const remaining = internalQuery({
  args: { instance: v.string(), thread: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workItems")
      .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", args.thread).eq("status", "queued"),
      )
      .take(32_000);
    return rows.length;
  },
});

export const prepareExplicitDerive = internalMutation({
  args: {
    instance: v.string(),
    thread: v.string(),
    scope: v.union(v.literal("message"), v.literal("turn"), v.literal("chunk")),
    subject: v.string(),
    deriv: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_instance_and_thread", (q) => q.eq("instance", args.instance).eq("thread", args.thread))
      .unique();
    if (thread === null)
      return { ok: false as const, code: "thread_not_found", reason: `thread ${args.thread} not found` };

    let kind: string;
    let owner: "messages" | "turns";
    let sourceRef: Record<string, string>;
    let targets: Array<{ scope: "message" | "turn" | "chunk"; subject: string; deriv: string }>;
    if (args.scope === "message") {
      const message = await ctx.db
        .query("messages")
        .withIndex("by_instance_and_thread_and_message", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("message", args.subject),
        )
        .unique();
      if (message === null || message.deletedAt !== undefined) {
        return {
          ok: false as const,
          code: "message_not_found",
          reason: `no message ${args.subject} exists in this thread`,
        };
      }
      if (message.kind === "user_prompt") kind = "prompt_smoothing";
      else if (message.kind === "tool_result") kind = "tool_result_summary";
      else return { ok: true as const, outcome: "not_derivable" as const, subject: args.subject };
      owner = "messages";
      sourceRef = { messageId: args.subject };
      targets = [
        {
          scope: "message",
          subject: args.subject,
          deriv: kind === "prompt_smoothing" ? "smoothed_prompt" : "tool_result_summary",
        },
      ];
    } else if (args.scope === "turn") {
      const turn = await ctx.db
        .query("turns")
        .withIndex("by_instance_and_thread_and_turn", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("turn", args.subject),
        )
        .unique();
      if (turn === null || turn.deletedAt !== undefined) {
        return { ok: false as const, code: "turn_not_found", reason: `no turn ${args.subject} exists in this thread` };
      }
      if (turn.status !== "closed") {
        return { ok: false as const, code: "turn_open", reason: `turn ${args.subject} is open and cannot be derived` };
      }
      kind = "turn_derivation";
      owner = "turns";
      sourceRef = { turnId: args.subject };
      targets = [
        { scope: "turn", subject: args.subject, deriv: "turn_rendering" },
        { scope: "turn", subject: args.subject, deriv: "pre_detailed_assembly" },
      ];
    } else {
      const deriv = args.deriv;
      if (deriv !== "chunk_summary_detailed" && deriv !== "chunk_summary_brief") {
        return { ok: false as const, code: "invalid_event", reason: `unknown chunk derivation ${String(deriv)}` };
      }
      const chunk = await ctx.db
        .query("chunks")
        .withIndex("by_instance_and_thread_and_chunk", (q) =>
          q.eq("instance", args.instance).eq("thread", args.thread).eq("chunk", args.subject),
        )
        .unique();
      if (chunk === null) {
        return { ok: false as const, code: "turn_not_found", reason: `no chunk ${args.subject} exists in this thread` };
      }
      kind = deriv;
      owner = "turns";
      sourceRef = { chunkId: args.subject };
      targets = [{ scope: "chunk", subject: args.subject, deriv }];
    }

    const rows = [];
    for (const target of targets) {
      rows.push(
        await ctx.db
          .query("derivations")
          .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
            q
              .eq("instance", args.instance)
              .eq("thread", args.thread)
              .eq("scope", target.scope)
              .eq("subject", target.subject)
              .eq("deriv", target.deriv),
          )
          .unique(),
      );
    }
    const sourceVersion = Math.max(0, ...rows.map((row) => row?.sourceVersion ?? 0)) + 1;
    const cursor: QueueCursor = { next: thread.nextWorkSequence };
    const item = await enqueueWork(ctx, thread, cursor, {
      owner,
      kind,
      sourceRef,
      derivations: targets,
      sourceVersion,
    });
    await ctx.db.patch("threads", thread._id, { nextWorkSequence: cursor.next });
    return { ok: true as const, outcome: "queued" as const, item, sourceVersion };
  },
});

export const readExplicitDerive = internalQuery({
  args: {
    instance: v.string(),
    thread: v.string(),
    scope: v.union(v.literal("message"), v.literal("turn"), v.literal("chunk")),
    subject: v.string(),
    derivs: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = [];
    for (const deriv of args.derivs) {
      const row = await ctx.db
        .query("derivations")
        .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
          q
            .eq("instance", args.instance)
            .eq("thread", args.thread)
            .eq("scope", args.scope)
            .eq("subject", args.subject)
            .eq("deriv", deriv),
        )
        .unique();
      rows.push(row);
    }
    return rows;
  },
});

async function runLoop(ctx: ActionCtx, args: { instance: string; thread: string; maxItems?: number }) {
  const report = { claimed: 0, completed: 0, failed: 0, blocked: 0, staleDiscarded: 0, remaining: 0 };
  const maxItems = args.maxItems ?? Number.POSITIVE_INFINITY;
  while (report.claimed < maxItems) {
    const claimed: { item: Doc<"workItems">; instance: Doc<"instances"> } | null = await ctx.runMutation(
      internal.queue.claim,
      { instance: args.instance, thread: args.thread },
    );
    if (claimed === null) break;
    report.claimed += 1;
    const source: Record<string, unknown> = await ctx.runQuery(internal.queue.readSource, {
      instance: args.instance,
      thread: args.thread,
      kind: claimed.item.kind,
      sourceRef: claimed.item.sourceRef,
    });
    const result = await handleWork(ctx, claimed, source);
    const completed: { disposition: "done" | "failed" | "blocked" | "stale" | "lost" } = await ctx.runMutation(
      internal.queue.complete,
      {
        instance: args.instance,
        thread: args.thread,
        workItem: claimed.item.workItem,
        result,
      },
    );
    if (completed.disposition === "done") report.completed += 1;
    else if (completed.disposition === "failed") report.failed += 1;
    else if (completed.disposition === "blocked") report.blocked += 1;
    else if (completed.disposition === "stale") report.staleDiscarded += 1;
  }
  report.remaining = await ctx.runQuery(internal.queue.remaining, { instance: args.instance, thread: args.thread });
  return report;
}

export const drainLoop = internalAction({
  args: { instance: v.string(), thread: v.string() },
  handler: async (ctx, args) => {
    const report = await runLoop(ctx, args);
    await ctx.runMutation(internal.queue.drainExit, args);
    return report;
  },
});

/**
 * The transactional exit gate for a scheduled drain: work enqueued before this
 * mutation is visible here (reschedule); the empty case clears the recorded
 * drain id, so a later enqueue schedules its own drain rather than trusting an
 * action that may already be past its final claim. Manual drains do not pass
 * through here — manual mode never self-schedules.
 */
export const drainExit = internalMutation({
  args: { instance: v.string(), thread: v.string() },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_instance_and_thread", (q) =>
        q.eq("instance", args.instance).eq("thread", args.thread),
      )
      .unique();
    if (thread === null) return { rescheduled: false };
    const queued = await ctx.db
      .query("workItems")
      .withIndex("by_instance_and_thread_and_status_and_seq", (q) =>
        q.eq("instance", args.instance).eq("thread", args.thread).eq("status", "queued"),
      )
      .first();
    if (queued === null) {
      await ctx.db.patch("threads", thread._id, { scheduledDrainId: undefined });
      return { rescheduled: false };
    }
    await startDrain(ctx, thread._id, args.instance, args.thread);
    return { rescheduled: true };
  },
});

export async function drainWork(ctx: ActionCtx, args: { instance: string; thread: string; maxItems?: number }) {
  return await runLoop(ctx, args);
}
