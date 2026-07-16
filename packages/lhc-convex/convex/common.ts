import type { FunctionHandle } from "convex/server";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

export type Reader = QueryCtx["db"] | MutationCtx["db"];
export type Writer = MutationCtx["db"];
export type ThreadDoc = Doc<"threads">;

export type LhcErrorCode =
  | "thread_not_found"
  | "path_exists"
  | "ambiguous_thread_id"
  | "invalid_thread_ref"
  | "invalid_event"
  | "empty_batch"
  | "turn_state_corrupt"
  | "message_not_found"
  | "turn_open"
  | "message_initiates_turn"
  | "turn_not_found"
  | "unknown_profile"
  | "invalid_view_config"
  | "compact_stopped"
  | "invalid_bounds"
  | "invalid_target_tokens";

export function callerError(code: LhcErrorCode, reason: string, eventIndex?: number) {
  return {
    ok: false as const,
    error: {
      errorClass: code === "turn_state_corrupt" ? ("state_corruption" as const) : ("caller_error" as const),
      code,
      reason,
      ...(eventIndex === undefined ? {} : { eventIndex }),
    },
  };
}

export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

export interface StoredConfig {
  mode: "background" | "manual";
  assignments: Record<string, StoredAssignment>;
  timeoutMs: number;
  maxInputChars: number;
  guards: {
    smoothedPrompt: { maxInferenceTokens: number; suspiciousOutputRatio: number };
    toolResultSummary: { timeoutMs: number };
    detailedTurnCompression: { tinyTurnTokens: number };
  };
  toolResult: { smallTierTokens: number; smallTargetRatio: number; midTargetRatio: number };
  chunkPolicy: { targetProjectedTokens: number; maxProjectedTokens: number };
  view: {
    profiles: Record<string, StoredProfile>;
    visibility: { maxTokens: number; targetTokens: number };
    compactThreshold: number;
  };
}

export interface StoredAssignment {
  provider: string;
  model: string;
  prompt: string;
  targetMinRatio?: number;
  targetMaxRatio?: number;
  targetAimRatio?: number;
  thinking?: "none" | "minimal" | "medium" | "high";
}

export interface StoredProfile {
  name: string;
  lowerBound: number;
  percentages: { full: number; smooth: number; detailed: number; brief: number };
}

const DEFAULT_ASSIGNMENT: StoredAssignment = {
  provider: "codex",
  model: "gpt-5.4-mini",
  prompt: "smoothing-v1",
  thinking: "none",
};

const BUILT_IN_PROFILES: Record<string, StoredProfile> = {
  continuation: {
    name: "continuation",
    lowerBound: 120_000,
    percentages: { full: 30, smooth: 30, detailed: 20, brief: 20 },
  },
  conversation: {
    name: "conversation",
    lowerBound: 120_000,
    percentages: { full: 12, smooth: 48, detailed: 20, brief: 20 },
  },
  coding: {
    name: "coding",
    lowerBound: 120_000,
    percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 },
  },
};

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeConfig(raw: Record<string, unknown>): StoredConfig {
  const inference = (raw["inference"] ?? {}) as Record<string, unknown>;
  const assignments = (inference["assignments"] ?? {}) as Record<string, StoredAssignment>;
  const guards = (raw["guards"] ?? {}) as Record<string, Record<string, unknown>>;
  const toolResult = (raw["toolResult"] ?? {}) as Record<string, unknown>;
  const chunkPolicy = (raw["chunkPolicy"] ?? {}) as Record<string, unknown>;
  const view = (raw["view"] ?? {}) as Record<string, unknown>;
  const visibility = (view["visibility"] ?? {}) as Record<string, unknown>;
  const profiles = { ...BUILT_IN_PROFILES };
  const configuredProfiles = Array.isArray(view["profiles"])
    ? (view["profiles"] as Array<Partial<StoredProfile> & { name?: string }>)
    : [];
  for (const profile of configuredProfiles) {
    if (typeof profile.name !== "string") continue;
    const base = profiles[profile.name];
    if (base === undefined && (profile.lowerBound === undefined || profile.percentages === undefined)) continue;
    profiles[profile.name] = {
      name: profile.name,
      lowerBound: finitePositive(profile.lowerBound, base?.lowerBound ?? 120_000),
      percentages: {
        ...(base?.percentages ?? { full: 30, smooth: 30, detailed: 20, brief: 20 }),
        ...(profile.percentages ?? {}),
      },
    };
  }
  return {
    mode: raw["mode"] === "manual" ? "manual" : "background",
    assignments: {
      smoothed_prompt: { ...DEFAULT_ASSIGNMENT, prompt: "smoothing-v1", ...assignments["smoothed_prompt"] },
      tool_result_summary: { ...DEFAULT_ASSIGNMENT, prompt: "tool-result-v2", ...assignments["tool_result_summary"] },
      detailed_turn_compression: {
        ...DEFAULT_ASSIGNMENT,
        prompt: "detailed-turn-compression-v3",
        targetMinRatio: 0.35,
        targetAimRatio: 0.5,
        targetMaxRatio: 0.65,
        ...assignments["detailed_turn_compression"],
      },
      chunk_summary_brief: {
        ...DEFAULT_ASSIGNMENT,
        prompt: "chunk-brief-v3",
        targetMinRatio: 0.08,
        targetAimRatio: 0.12,
        targetMaxRatio: 0.2,
        ...assignments["chunk_summary_brief"],
      },
    },
    timeoutMs: finitePositive(inference["timeoutMs"], 60_000),
    maxInputChars: finitePositive(inference["maxInputChars"], 200_000),
    guards: {
      smoothedPrompt: {
        maxInferenceTokens: finitePositive(guards["smoothedPrompt"]?.["maxInferenceTokens"], 700),
        suspiciousOutputRatio: finitePositive(guards["smoothedPrompt"]?.["suspiciousOutputRatio"], 0.15),
      },
      toolResultSummary: {
        timeoutMs: finitePositive(guards["toolResultSummary"]?.["timeoutMs"], 60_000),
      },
      detailedTurnCompression: {
        tinyTurnTokens: finitePositive(guards["detailedTurnCompression"]?.["tinyTurnTokens"], 80),
      },
    },
    toolResult: {
      smallTierTokens: finitePositive(toolResult["smallTierTokens"], 1_000),
      smallTargetRatio: finitePositive(toolResult["smallTargetRatio"], 0.15),
      midTargetRatio: finitePositive(toolResult["midTargetRatio"], 0.04),
    },
    chunkPolicy: {
      targetProjectedTokens: finitePositive(chunkPolicy["targetProjectedTokens"], 2_200),
      maxProjectedTokens: finitePositive(chunkPolicy["maxProjectedTokens"], 4_400),
    },
    view: {
      profiles,
      visibility: {
        maxTokens: finitePositive(visibility["maxTokens"], 64_000),
        targetTokens: finitePositive(visibility["targetTokens"], 32_000),
      },
      compactThreshold: finitePositive(view["compactThreshold"], 160_000),
    },
  };
}

export async function upsertInstance(
  ctx: MutationCtx,
  args: { instance: string; config: Record<string, unknown>; modelCallHandle: string },
): Promise<Doc<"instances">> {
  const existing = await ctx.db
    .query("instances")
    .withIndex("by_instance", (q) => q.eq("instance", args.instance))
    .unique();
  const config = normalizeConfig(args.config);
  if (existing === null) {
    const id = await ctx.db.insert("instances", {
      instance: args.instance,
      config,
      modelCallHandle: args.modelCallHandle,
    });
    return (await ctx.db.get("instances", id))!;
  }
  await ctx.db.patch("instances", existing._id, { config, modelCallHandle: args.modelCallHandle });
  return { ...existing, config, modelCallHandle: args.modelCallHandle };
}

export async function readInstance(db: Reader, instance: string): Promise<Doc<"instances"> | null> {
  return await db
    .query("instances")
    .withIndex("by_instance", (q) => q.eq("instance", instance))
    .unique();
}

export async function resolveThread(
  db: Reader,
  instance: string,
  ref: { threadId?: string; filePath?: string },
): Promise<{ ok: true; thread: ThreadDoc } | ReturnType<typeof callerError>> {
  if (ref.filePath !== undefined) {
    if (ref.filePath.trim() === "") return callerError("invalid_thread_ref", "filePath must be a non-empty alias");
    const thread = await db
      .query("threads")
      .withIndex("by_instance_and_filePath", (q) => q.eq("instance", instance).eq("filePath", ref.filePath!))
      .unique();
    return thread === null
      ? callerError("thread_not_found", `no thread registered with filePath alias ${ref.filePath}`)
      : { ok: true, thread };
  }
  const prefix = ref.threadId ?? "";
  if (prefix.trim() === "") return callerError("invalid_thread_ref", "threadId must be non-empty");
  const exact = await db
    .query("threads")
    .withIndex("by_instance_and_thread", (q) => q.eq("instance", instance).eq("thread", prefix))
    .unique();
  if (exact !== null) return { ok: true, thread: exact };
  const matches = await db
    .query("threads")
    .withIndex("by_instance_and_thread", (q) =>
      q.eq("instance", instance).gte("thread", prefix).lt("thread", `${prefix}\uffff`),
    )
    .take(2);
  if (matches.length === 1) return { ok: true, thread: matches[0]! };
  if (matches.length > 1) {
    return callerError(
      "ambiguous_thread_id",
      `thread id "${prefix}" is ambiguous: it matches multiple threads; use a longer id`,
    );
  }
  return callerError("thread_not_found", `no thread registered with id ${prefix}`);
}

export interface QueueCursor {
  next: number;
}

export async function enqueueWork(
  ctx: MutationCtx,
  thread: ThreadDoc,
  cursor: QueueCursor,
  input: {
    owner: "messages" | "turns";
    kind: string;
    sourceRef: Record<string, string>;
    derivations: Array<{ scope: "message" | "turn" | "chunk"; subject: string; deriv: string }>;
    sourceVersion?: number;
  },
): Promise<{ workItemId: string; owner: "messages" | "turns"; kind: string; sourceRef: Record<string, string> }> {
  const seq = cursor.next++;
  const workItemId = `w${seq}`;
  const sourceVersion = input.sourceVersion ?? 1;
  for (const target of input.derivations) {
    const existing = await ctx.db
      .query("derivations")
      .withIndex("by_instance_and_thread_and_scope_and_subject_and_deriv", (q) =>
        q
          .eq("instance", thread.instance)
          .eq("thread", thread.thread)
          .eq("scope", target.scope)
          .eq("subject", target.subject)
          .eq("deriv", target.deriv),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("derivations", {
        instance: thread.instance,
        thread: thread.thread,
        scope: target.scope,
        subject: target.subject,
        deriv: target.deriv,
        state: "pending",
        sourceVersion,
      });
    } else {
      await ctx.db.patch("derivations", existing._id, {
        state: "pending",
        sourceVersion,
        content: undefined,
        reason: undefined,
        metadata: undefined,
        gaps: undefined,
        derivedAt: undefined,
      });
    }
  }
  await ctx.db.insert("workItems", {
    instance: thread.instance,
    thread: thread.thread,
    workItem: workItemId,
    seq,
    owner: input.owner,
    kind: input.kind,
    sourceRef: input.sourceRef,
    sourceVersion,
    status: "queued",
    queuedAt: nowIso(),
    derivs: input.derivations,
  });
  return { workItemId, owner: input.owner, kind: input.kind, sourceRef: input.sourceRef };
}

export function asModelCallHandle(value: string): FunctionHandle<"action", Record<string, unknown>, unknown> {
  return value as FunctionHandle<"action", Record<string, unknown>, unknown>;
}
