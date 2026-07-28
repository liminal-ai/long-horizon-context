import { v } from "convex/values";
import { estimateTokens } from "../src/shared/token_counting/index.js";
import type { CompactChunkMaterialSnapshot } from "../src/shared/view_render.js";
import {
  assembleBandText,
  excerptLine,
  renderTailMessage,
  type TailMessageRow,
  toolNamesByCallId,
  toolResultSessionContent,
} from "../src/shared/view_render.js";
import {
  PI_MAPPABLE_MESSAGE_KINDS,
  type SelectionInputs,
  type SelectionResult,
  selectArrangement,
} from "../src/shared/view_select.js";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import {
  callerError,
  nowIso,
  type Reader,
  readInstance,
  resolveThread,
  type StoredConfig,
  type StoredProfile,
} from "./common.js";

const BAND_ORDER = ["brief", "detailed", "smooth"] as const;

type BlockDoc = Doc<"messageBlocks">;

async function blocksByMessage(db: Reader, instance: string, thread: string): Promise<Map<string, BlockDoc[]>> {
  const rows = await db
    .query("messageBlocks")
    .withIndex("by_instance_and_thread_and_message_and_blockIndex", (q) =>
      q.eq("instance", instance).eq("thread", thread),
    )
    .take(32_000);
  const byMessage = new Map<string, BlockDoc[]>();
  for (const row of rows) {
    const blocks = byMessage.get(row.message) ?? [];
    blocks.push(row);
    byMessage.set(row.message, blocks);
  }
  return byMessage;
}

async function tailRows(db: Reader, instance: string, thread: string, compactPoint: number): Promise<TailMessageRow[]> {
  const [messages, events, blockMap] = await Promise.all([
    db
      .query("messages")
      .withIndex("by_instance_and_thread_and_deletedAt_and_sourceOrder", (q) =>
        q.eq("instance", instance).eq("thread", thread).eq("deletedAt", undefined).gt("sourceOrder", compactPoint),
      )
      .take(32_000),
    db
      .query("events")
      .withIndex("by_instance_and_thread_and_eventOrder", (q) => q.eq("instance", instance).eq("thread", thread))
      .take(32_000),
    blocksByMessage(db, instance, thread),
  ]);
  const idemByOrder = new Map(events.map((event) => [event.eventOrder, event.idemKey]));
  const rows: TailMessageRow[] = [];
  for (const message of messages) {
    const blocks = blockMap.get(message.message) ?? [];
    rows.push({
      messageId: message.message,
      sourceEventOrder: message.sourceOrder,
      idempotencyKey: idemByOrder.get(message.sourceOrder) ?? null,
      kind: message.kind as TailMessageRow["kind"],
      recordedAt: message.recordedAt,
      blocks: blocks.map((block) => ({
        blockType: block.blockType,
        content: block.content as Record<string, unknown>,
      })),
    });
  }
  return rows;
}

async function readView(db: Reader, instance: string, thread: string) {
  const view = await db
    .query("threadViews")
    .withIndex("by_instance_and_thread", (q) => q.eq("instance", instance).eq("thread", thread))
    .unique();
  if (view === null) return null;
  const bands = await db
    .query("threadViewBands")
    .withIndex("by_instance_and_thread_and_view_and_band", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("view", view.view),
    )
    .take(3);
  return {
    view,
    bands: BAND_ORDER.flatMap((band) => {
      const row = bands.find((candidate) => candidate.band === band);
      return row === undefined ? [] : [row];
    }),
  };
}

async function readBoundary(db: Reader, instance: string, thread: string): Promise<number> {
  const row = await db
    .query("viewBoundaries")
    .withIndex("by_instance_and_thread", (q) => q.eq("instance", instance).eq("thread", thread))
    .unique();
  return row?.position ?? 0;
}

async function buildSelectionInputs(
  db: Reader,
  instance: string,
  thread: string,
  includeChunkMaterials: boolean,
): Promise<SelectionInputs> {
  const turnRows = await db
    .query("turns")
    .withIndex("by_instance_and_thread_and_deletedAt_and_turnOrder", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("deletedAt", undefined),
    )
    .take(32_000);
  const allTurnIds = new Set(turnRows.map((turn) => turn.turn));
  const turns = turnRows.map((turn) => ({
      turnId: turn.turn,
      turnOrder: turn.turnOrder,
      status: turn.status,
      openedAt: turn.openedAtEventOrder,
      closedAt: turn.closedAtEventOrder ?? null,
    }));
  const openTurns = turns.filter((turn) => turn.status === "open");
  if (openTurns.length > 1) throw new Error(`turn_state_corrupt: ${openTurns.length} open turns`);
  for (const turn of turns) {
    if (turn.status === "closed" && turn.closedAt === null) {
      throw new Error(`source_damaged: closed turn ${turn.turnId} carries no close boundary`);
    }
  }
  const [messageRows, eventRows, blockMap, allChunkMembers] = await Promise.all([
    db
      .query("messages")
      .withIndex("by_instance_and_thread_and_deletedAt_and_sourceOrder", (q) =>
        q.eq("instance", instance).eq("thread", thread).eq("deletedAt", undefined),
      )
      .take(32_000),
    db
      .query("events")
      .withIndex("by_instance_and_thread_and_eventOrder", (q) => q.eq("instance", instance).eq("thread", thread))
      .order("desc")
      .take(1),
    blocksByMessage(db, instance, thread),
    db
      .query("chunkMembers")
      .withIndex("by_instance_and_thread_and_chunk_and_memberIdx", (q) =>
        q.eq("instance", instance).eq("thread", thread),
      )
      .take(32_000),
  ]);
  const messages = [];
  for (const message of messageRows) {
    if (!allTurnIds.has(message.turn))
      throw new Error(`source_damaged: message ${message.message} references missing turn`);
    const blocks = blockMap.get(message.message) ?? [];
    messages.push({
      messageId: message.message,
      order: message.sourceOrder,
      kind: message.kind,
      tokenEstimate: message.tokenEstimate,
      turnId: message.turn,
      text: excerptLine(
        message.kind,
        blocks.map((block) => ({ blockType: block.blockType, content: block.content as Record<string, unknown> })),
      ),
    });
  }
  const chunkRows = await db
    .query("chunks")
    .withIndex("by_instance_and_thread_and_chunkOrder", (q) => q.eq("instance", instance).eq("thread", thread))
    .take(32_000);
  const membersByChunk = new Map<string, typeof allChunkMembers>();
  for (const member of allChunkMembers) {
    const members = membersByChunk.get(member.chunk) ?? [];
    members.push(member);
    membersByChunk.set(member.chunk, members);
  }
  const chunks = [];
  for (const chunk of chunkRows) {
    const members = membersByChunk.get(chunk.chunk) ?? [];
    for (const member of members) {
      if (!allTurnIds.has(member.turn)) throw new Error(`source_damaged: chunk ${chunk.chunk} references missing turn`);
    }
    chunks.push({
      chunkId: chunk.chunk,
      chunkOrder: chunk.chunkOrder,
      status: chunk.status,
      memberTurnIds: members.map((member) => member.turn),
    });
  }
  const derivationRows = await db
    .query("derivations")
    .withIndex("by_instance_and_thread_and_state", (q) => q.eq("instance", instance).eq("thread", thread))
    .take(32_000);
  const derivations = new Map<
    string,
    { state: "pending" | "ready" | "failed" | "blocked"; content?: string; reason?: string }
  >();
  const derivationCounts: Record<string, Record<string, number>> = {};
  for (const row of derivationRows) {
    derivations.set(`${row.subject}/${row.deriv}`, {
      state: row.state,
      ...(row.content === undefined ? {} : { content: row.content }),
      ...(row.reason === undefined ? {} : { reason: row.reason }),
    });
    derivationCounts[row.deriv] = {
      ...(derivationCounts[row.deriv] ?? {}),
      [row.state]: (derivationCounts[row.deriv]?.[row.state] ?? 0) + 1,
    };
  }
  const compactChunkMaterials = includeChunkMaterials ? new Map<string, CompactChunkMaterialSnapshot>() : undefined;
  if (compactChunkMaterials !== undefined) {
    for (const chunk of chunks) {
      for (const derivationType of ["chunk_summary_detailed", "chunk_summary_brief"] as const) {
        const row = derivations.get(`${chunk.chunkId}/${derivationType}`);
        if (row?.state === "ready" && row.content !== undefined) {
          compactChunkMaterials.set(`${chunk.chunkId}/${derivationType}`, { kind: "ready", content: row.content });
          continue;
        }
        const sections: string[] = [];
        for (const turnId of chunk.memberTurnIds) {
          const compression = derivations.get(`${turnId}/detailed_turn_compression`);
          const assembly = derivations.get(`${turnId}/pre_detailed_assembly`);
          const rendering = derivations.get(`${turnId}/turn_rendering`);
          sections.push(compression?.content ?? assembly?.content ?? rendering?.content ?? "");
        }
        compactChunkMaterials.set(`${chunk.chunkId}/${derivationType}`, {
          kind: "concat",
          content: sections.join("\n\n---\n\n"),
          reason: row === undefined ? "missing_derivation" : row.state === "failed" ? "failed_floor" : "not_ready",
        });
      }
    }
  }
  return {
    messages,
    turns,
    chunks,
    derivations,
    ...(compactChunkMaterials === undefined ? {} : { compactChunkMaterials }),
    maxEventOrder: eventRows[0]?.eventOrder ?? 0,
    derivationCounts,
  };
}

function compactProfile(
  config: StoredConfig,
  profileName: string | undefined,
  params: Record<string, unknown> | undefined,
) {
  const name = profileName ?? "continuation";
  const base = config.view.profiles[name];
  if (base === undefined) return callerError("unknown_profile", `unknown profile "${name}"`);
  const percentages = {
    ...base.percentages,
    ...((params?.["percentages"] ?? {}) as Partial<StoredProfile["percentages"]>),
  };
  const lowerBound = typeof params?.["lowerBound"] === "number" ? params["lowerBound"] : base.lowerBound;
  if (!Number.isFinite(lowerBound) || lowerBound <= 0) {
    return callerError("invalid_view_config", `lowerBound must be positive; received ${String(lowerBound)}`);
  }
  const sum = percentages.full + percentages.smooth + percentages.detailed + percentages.brief;
  if (sum !== 100) return callerError("invalid_view_config", `band percentages must sum to 100; received ${sum}`);
  return {
    ok: true as const,
    value: { name, lowerBound, percentages, profileName: params === undefined ? name : null },
  };
}

async function assembledContext(db: Reader, instance: string, thread: string) {
  const snapshot = await readView(db, instance, thread);
  const compactPoint = snapshot?.view.compactPoint ?? 0;
  const boundaryPosition = await readBoundary(db, instance, thread);
  const rows = await tailRows(db, instance, thread, compactPoint);
  const names = toolNamesByCallId(rows);
  const entries: Array<{ message: { role: "user" | "assistant"; content: string }; band?: string }> = [];
  for (const band of snapshot?.bands ?? []) {
    entries.push({
      message: { role: "user", content: `[context · ${band.band}]\n${band.renderedText}` },
      band: band.band,
    });
  }
  for (const row of rows) {
    entries.push({ message: renderTailMessage(row, { boundaryPosition, toolNameByCallId: names }) });
  }
  return { snapshot, compactPoint, boundaryPosition, rows, entries };
}

export const getLlmRequestContext = query({
  args: { instance: v.string(), ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }) },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const assembled = await assembledContext(ctx.db, args.instance, resolved.thread.thread);
    return {
      ok: true as const,
      value: {
        threadId: resolved.thread.thread,
        messages: assembled.entries.map((entry) => ({
          role: entry.message.role,
          content: [{ type: "text" as const, text: entry.message.content }],
        })),
      },
    };
  },
});

function parseModelRef(model: string) {
  const slash = model.indexOf("/");
  return slash <= 0 || slash === model.length - 1
    ? null
    : { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

export const getSessionThreadView = query({
  args: { instance: v.string(), ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }) },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const assembled = await assembledContext(ctx.db, args.instance, resolved.thread.thread);
    const source = (row: TailMessageRow) => ({ messageId: row.messageId, idempotencyKey: row.idempotencyKey });
    const names = toolNamesByCallId(assembled.rows);
    const entries: Array<Record<string, unknown>> = (assembled.snapshot?.bands ?? []).map((band) => ({
      role: "user",
      content: `[context · ${band.band}]\n${band.renderedText}`,
      sourceMessages: [],
    }));
    let parts: Array<Record<string, unknown>> = [];
    let sources: Array<Record<string, unknown>> = [];
    const flush = () => {
      if (parts.length > 0) entries.push({ role: "assistant", content: parts, sourceMessages: sources });
      parts = [];
      sources = [];
    };
    for (const row of assembled.rows) {
      const block = row.blocks[0]?.content ?? {};
      const text = typeof block["text"] === "string" ? block["text"] : "";
      if (row.kind === "user_prompt" || row.kind === "runtime_note") {
        flush();
        entries.push({
          role: "user",
          content: row.kind === "runtime_note" ? `[runtime note] ${text}` : text,
          sourceMessages: [source(row)],
        });
      } else if (row.kind === "assistant_text") {
        parts.push({ type: "text", text });
        sources.push(source(row));
      } else if (row.kind === "assistant_thinking") {
        parts.push({ type: "thinking", thinking: text });
        sources.push(source(row));
      } else if (row.kind === "tool_call") {
        parts.push({
          type: "toolCall",
          toolCallId: typeof block["toolCallId"] === "string" ? block["toolCallId"] : "",
          toolName: typeof block["toolName"] === "string" ? block["toolName"] : "unknown_tool",
          arguments: typeof block["arguments"] === "object" && block["arguments"] !== null ? block["arguments"] : {},
        });
        sources.push(source(row));
      } else if (row.kind === "tool_result") {
        flush();
        const toolCallId = typeof block["toolCallId"] === "string" ? block["toolCallId"] : "";
        entries.push({
          role: "toolResult",
          toolCallId,
          toolName: names.get(toolCallId) ?? "unknown_tool",
          content: toolResultSessionContent(row, {
            boundaryPosition: assembled.boundaryPosition,
            toolNameByCallId: names,
          }),
          ...(block["isError"] === true ? { isError: true } : {}),
          sourceMessages: [source(row)],
        });
      } else if (row.kind === "model_change") {
        const parsed = parseModelRef(String(block["newModel"] ?? ""));
        if (parsed !== null) entries.push({ kind: "model_change", ...parsed, sourceMessages: [source(row)] });
      } else if (row.kind === "thinking_level_change") {
        entries.push({
          kind: "thinking_level_change",
          level: String(block["newLevel"] ?? ""),
          sourceMessages: [source(row)],
        });
      }
    }
    flush();
    return { ok: true as const, value: { threadId: resolved.thread.thread, entries } };
  },
});

export const describe = query({
  args: { instance: v.string(), ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }) },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const snapshot = await readView(ctx.db, args.instance, resolved.thread.thread);
    if (snapshot === null) return { ok: true as const, value: null };
    return {
      ok: true as const,
      value: {
        viewId: snapshot.view.view,
        createdAt: snapshot.view.createdAt,
        compactPoint: snapshot.view.compactPoint,
        coveredFrom: snapshot.view.coveredFrom,
        profileName: snapshot.view.profileName ?? null,
        config: snapshot.view.config,
        arrangement: snapshot.view.arrangement,
        gaps: snapshot.view.gaps,
        sourceState: snapshot.view.sourceState,
        bands: snapshot.bands.map((band) => ({ band: band.band, storedTokens: band.tokenCount })),
      },
    };
  },
});

async function tailTokenSum(db: Reader, instance: string, thread: string, compactPoint: number) {
  const rows = await db
    .query("messages")
    .withIndex("by_instance_and_thread_and_deletedAt_and_sourceOrder", (q) =>
      q.eq("instance", instance).eq("thread", thread).eq("deletedAt", undefined).gt("sourceOrder", compactPoint),
    )
    .take(32_000);
  return rows.reduce((sum, row) => sum + row.tokenEstimate, 0);
}

async function visibilityTokens(db: Reader, instance: string, thread: string, boundary: number, compactPoint: number) {
  const start = Math.max(boundary, compactPoint);
  const rows = await db
    .query("messages")
    .withIndex("by_instance_and_thread_and_kind_and_deletedAt_and_sourceOrder", (q) =>
      q
        .eq("instance", instance)
        .eq("thread", thread)
        .eq("kind", "tool_result")
        .eq("deletedAt", undefined)
        .gt("sourceOrder", start),
    )
    .take(32_000);
  return rows.reduce((sum, row) => sum + row.tokenEstimate, 0);
}

export const status = query({
  args: { instance: v.string(), ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }) },
  handler: async (ctx, args) => {
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const instance = await readInstance(ctx.db, args.instance);
    if (instance === null) return callerError("thread_not_found", `component instance ${args.instance} not found`);
    const config = instance.config as StoredConfig;
    const snapshot = await readView(ctx.db, args.instance, resolved.thread.thread);
    const compactPoint = snapshot?.view.compactPoint ?? 0;
    const boundaryPosition = await readBoundary(ctx.db, args.instance, resolved.thread.thread);
    const derivations = await ctx.db
      .query("derivations")
      .withIndex("by_instance_and_thread_and_state", (q) =>
        q.eq("instance", args.instance).eq("thread", resolved.thread.thread),
      )
      .take(32_000);
    const tailTokens = await tailTokenSum(ctx.db, args.instance, resolved.thread.thread, compactPoint);
    const counts = { pending: 0, failed: 0, blocked: 0 };
    for (const row of derivations) if (row.state !== "ready") counts[row.state] += 1;
    return {
      ok: true as const,
      value: {
        tailTokens,
        threshold: config.view.compactThreshold,
        compactRecommended: tailTokens > config.view.compactThreshold,
        derivation: counts,
        view:
          snapshot === null
            ? null
            : {
                degraded: snapshot.view.arrangement.filter(
                  (entry) => (entry as { degraded?: boolean }).degraded === true,
                ).length,
                gaps: snapshot.view.gaps.length,
                builtAt: snapshot.view.createdAt,
              },
        visibility: {
          boundaryPosition,
          zoneTokens: await visibilityTokens(
            ctx.db,
            args.instance,
            resolved.thread.thread,
            boundaryPosition,
            compactPoint,
          ),
          maxTokens: config.view.visibility.maxTokens,
        },
      },
    };
  },
});

async function computeSelection(
  db: Reader,
  instanceId: string,
  thread: string,
  profileName: string | undefined,
  params: Record<string, unknown> | undefined,
  includeMaterials: boolean,
) {
  const instance = await readInstance(db, instanceId);
  if (instance === null) return callerError("thread_not_found", `component instance ${instanceId} not found`);
  const profile = compactProfile(instance.config as StoredConfig, profileName, params);
  if (!profile.ok) return profile;
  try {
    const inputs = await buildSelectionInputs(db, instanceId, thread, includeMaterials);
    const selection = selectArrangement(inputs, {
      lowerBound: profile.value.lowerBound,
      percentages: profile.value.percentages,
    });
    const firstKept = inputs.messages.find(
      (message) =>
        message.order > selection.compactPoint &&
        (PI_MAPPABLE_MESSAGE_KINDS as readonly string[]).includes(message.kind),
    );
    return {
      ok: true as const,
      value: { selection, inputs, profile: profile.value, firstKeptMessageId: firstKept?.messageId ?? null },
    };
  } catch (cause) {
    return callerError(
      String(cause).includes("turn_state_corrupt") ? "turn_state_corrupt" : "invalid_view_config",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
}

// The view's gaps: gap entries (a rendered subject with no usable material)
// and subjects the last band's walk skipped as too large (no entry at all).
// Both are holes in the same coverage window, so both land in the stored gaps
// and the receipt.
function gapNotes(selection: Pick<SelectionResult, "entries" | "skipped">) {
  return [
    ...selection.entries
      .filter((entry) => entry.gap)
      .map((entry) => ({ band: entry.band, subjectId: entry.subjectId, reason: entry.reason ?? "unknown" })),
    ...selection.skipped.map((skip) => ({ band: skip.band, subjectId: skip.subjectId, reason: skip.reason })),
  ];
}

export const previewCompact = query({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    profile: v.optional(v.string()),
    params: v.optional(v.any()),
    aborted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.aborted === true) return { ok: true as const, value: { kind: "error", reason: "compact stopped" } };
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const computed = await computeSelection(
      ctx.db,
      args.instance,
      resolved.thread.thread,
      args.profile,
      args.params as Record<string, unknown> | undefined,
      false,
    );
    if (!computed.ok) return { ok: true as const, value: { kind: "error", reason: computed.error.reason } };
    const stored = await readView(ctx.db, args.instance, resolved.thread.thread);
    const arrangement = computed.value.selection.entries.map((entry) => ({
      band: entry.band,
      subjectKind: entry.subjectKind,
      subjectId: entry.subjectId,
      derivationUsed: entry.derivationUsed,
      degraded: entry.degraded,
    }));
    const wouldProduceBands =
      computed.value.selection.compactPoint > 0 &&
      (stored === null ||
        stored.view.compactPoint !== computed.value.selection.compactPoint ||
        JSON.stringify(stored.view.arrangement) !== JSON.stringify(arrangement));
    return {
      ok: true as const,
      value: {
        kind: "ok",
        preview: {
          compactPoint: computed.value.selection.compactPoint,
          wouldProduceBands,
          tailTokens: await tailTokenSum(
            ctx.db,
            args.instance,
            resolved.thread.thread,
            computed.value.selection.compactPoint,
          ),
          firstKeptMessageId: computed.value.firstKeptMessageId,
        },
      },
    };
  },
});

export const compact = mutation({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    profile: v.optional(v.string()),
    params: v.optional(v.any()),
    aborted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.aborted === true) return callerError("compact_stopped", "compact stopped before snapshot write");
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const computed = await computeSelection(
      ctx.db,
      args.instance,
      resolved.thread.thread,
      args.profile,
      args.params as Record<string, unknown> | undefined,
      true,
    );
    if (!computed.ok) return computed;
    const { selection, inputs, profile, firstKeptMessageId } = computed.value;
    const existing = await readView(ctx.db, args.instance, resolved.thread.thread);
    if (existing !== null) {
      for (const band of existing.bands) await ctx.db.delete("threadViewBands", band._id);
      await ctx.db.delete("threadViews", existing.view._id);
    }
    const createdAt = nowIso();
    const viewId = `view_${resolved.thread.thread}_${selection.compactPoint}_${Date.now()}`;
    const arrangement = selection.entries.map((entry) => ({
      band: entry.band,
      subjectKind: entry.subjectKind,
      subjectId: entry.subjectId,
      derivationUsed: entry.derivationUsed,
      degraded: entry.degraded,
    }));
    const gaps = gapNotes(selection);
    await ctx.db.insert("threadViews", {
      instance: args.instance,
      thread: resolved.thread.thread,
      view: viewId,
      createdAt,
      compactPoint: selection.compactPoint,
      coveredFrom: selection.coveredFrom,
      ...(profile.profileName === null ? {} : { profileName: profile.profileName }),
      config: { lowerBound: profile.lowerBound, percentages: profile.percentages },
      arrangement,
      gaps,
      sourceState: { maxEventOrder: inputs.maxEventOrder, derivationCounts: inputs.derivationCounts },
    });
    const bands: Array<{ band: (typeof BAND_ORDER)[number]; renderedText: string; tokenCount: number }> = [];
    for (const band of BAND_ORDER) {
      const entries = selection.entries.filter((entry) => entry.band === band);
      if (entries.length === 0) continue;
      const renderedText = assembleBandText(entries.map((entry) => entry.text));
      const tokenCount = estimateTokens(renderedText);
      bands.push({ band, renderedText, tokenCount });
      await ctx.db.insert("threadViewBands", {
        instance: args.instance,
        thread: resolved.thread.thread,
        view: viewId,
        band,
        renderedText,
        tokenCount,
      });
    }
    const boundary = await ctx.db
      .query("viewBoundaries")
      .withIndex("by_instance_and_thread", (q) => q.eq("instance", args.instance).eq("thread", resolved.thread.thread))
      .unique();
    if (boundary !== null)
      await ctx.db.patch("viewBoundaries", boundary._id, { position: selection.compactPoint, updatedAt: createdAt });
    const bandReport = Object.fromEntries(
      BAND_ORDER.map((band) => {
        const stored = bands.find((candidate) => candidate.band === band);
        return [
          band,
          { entries: selection.entries.filter((entry) => entry.band === band).length, tokens: stored?.tokenCount ?? 0 },
        ];
      }),
    ) as Record<(typeof BAND_ORDER)[number], { entries: number; tokens: number }>;
    const tailTokens = await tailTokenSum(ctx.db, args.instance, resolved.thread.thread, selection.compactPoint);
    return {
      ok: true as const,
      value: {
        viewId,
        profile: profile.profileName,
        config: { ...profile.percentages, lowerBound: profile.lowerBound },
        bands: bandReport,
        tailTokens,
        totalTokens: BAND_ORDER.reduce((sum, band) => sum + bandReport[band].tokens, tailTokens),
        coveredFrom: selection.coveredFrom,
        compactPoint: selection.compactPoint,
        degraded: selection.entries
          .filter((entry) => entry.degraded)
          .map((entry) => ({ band: entry.band, subjectId: entry.subjectId, usedDerivation: entry.derivationUsed })),
        gaps,
        warnings: selection.entries
          .filter((entry) => entry.derivationUsed === "stored_member_concat")
          .map((entry) => ({ band: entry.band, subjectId: entry.subjectId, reason: entry.reason ?? "not_ready" })),
        renderedBands: bands.map((band) => ({ band: band.band, text: band.renderedText })),
        firstKeptMessageId,
      },
    };
  },
});

export const prune = mutation({
  args: {
    instance: v.string(),
    ref: v.object({ threadId: v.optional(v.string()), filePath: v.optional(v.string()) }),
    targetTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (
      args.targetTokens !== undefined &&
      (!Number.isFinite(args.targetTokens) || !Number.isInteger(args.targetTokens) || args.targetTokens < 0)
    ) {
      return callerError(
        "invalid_target_tokens",
        `targetTokens must be a non-negative finite integer; received ${String(args.targetTokens)}`,
      );
    }
    const resolved = await resolveThread(ctx.db, args.instance, args.ref);
    if (!resolved.ok) return resolved;
    const instance = await readInstance(ctx.db, args.instance);
    if (instance === null) return callerError("thread_not_found", `component instance ${args.instance} not found`);
    const targetTokens = args.targetTokens ?? (instance.config as StoredConfig).view.visibility.targetTokens;
    const snapshot = await readView(ctx.db, args.instance, resolved.thread.thread);
    const compactPoint = snapshot?.view.compactPoint ?? 0;
    const boundary = await ctx.db
      .query("viewBoundaries")
      .withIndex("by_instance_and_thread", (q) => q.eq("instance", args.instance).eq("thread", resolved.thread.thread))
      .unique();
    if (boundary === null) throw new Error("view boundary missing");
    const previousBoundary = boundary.position;
    const zoneTokensBefore = await visibilityTokens(
      ctx.db,
      args.instance,
      resolved.thread.thread,
      previousBoundary,
      compactPoint,
    );
    let newBoundary = previousBoundary;
    if (zoneTokensBefore > targetTokens) {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_instance_and_thread_and_kind_and_deletedAt_and_sourceOrder", (q) =>
          q
            .eq("instance", args.instance)
            .eq("thread", resolved.thread.thread)
            .eq("kind", "tool_result")
            .eq("deletedAt", undefined)
            .gt("sourceOrder", Math.max(previousBoundary, compactPoint)),
        )
        .order("desc")
        .take(32_000);
      let accumulated = 0;
      for (const row of rows) {
        if (accumulated + row.tokenEstimate <= targetTokens) accumulated += row.tokenEstimate;
        else {
          newBoundary = row.sourceOrder;
          break;
        }
      }
    }
    if (newBoundary > previousBoundary)
      await ctx.db.patch("viewBoundaries", boundary._id, { position: newBoundary, updatedAt: nowIso() });
    const pruned = await ctx.db
      .query("messages")
      .withIndex("by_instance_and_thread_and_kind_and_deletedAt_and_sourceOrder", (q) =>
        q
          .eq("instance", args.instance)
          .eq("thread", resolved.thread.thread)
          .eq("kind", "tool_result")
          .eq("deletedAt", undefined)
          .gt("sourceOrder", Math.max(previousBoundary, compactPoint))
          .lte("sourceOrder", newBoundary),
      )
      .take(32_000);
    const behind = await ctx.db
      .query("messages")
      .withIndex("by_instance_and_thread_and_kind_and_deletedAt_and_sourceOrder", (q) =>
        q
          .eq("instance", args.instance)
          .eq("thread", resolved.thread.thread)
          .eq("kind", "tool_result")
          .eq("deletedAt", undefined)
          .gt("sourceOrder", compactPoint)
          .lte("sourceOrder", newBoundary),
      )
      .take(32_000);
    return {
      ok: true as const,
      value: {
        previousBoundary,
        newBoundary,
        compactPoint,
        targetTokens,
        toolResultsPruned: newBoundary === previousBoundary ? 0 : pruned.length,
        tokensBehindBoundary: behind.reduce((sum, row) => sum + row.tokenEstimate, 0),
        zoneTokensBefore,
        zoneTokensAfter: await visibilityTokens(
          ctx.db,
          args.instance,
          resolved.thread.thread,
          newBoundary,
          compactPoint,
        ),
        noOp: newBoundary === previousBoundary,
      },
    };
  },
});
