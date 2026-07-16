import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { ComponentApi } from "../../convex/_generated/component.js";
import { PROMPT_NAMES as VALID_PROMPT_NAMES } from "../shared/prompts/index.js";
import type {
  BatchResult,
  ChunkDeriveResult,
  ChunkRecord,
  CompactReceipt,
  DerivationReportEntry,
  DrainReport,
  EventRecord,
  HealthReport,
  InspectOverview,
  LlmRequestContext,
  LogEntry,
  MessageDeriveResult,
  MessageDetail,
  MessageEventInput,
  MessageListOptions,
  MessageRecord,
  MutationResult,
  NewThreadInput,
  OpResult,
  PreviewCompactOutcome,
  PruneReceipt,
  SdkConfig,
  SessionThreadView,
  StoredDerivationLogEntry,
  StoredLogEntry,
  StoredView,
  ThreadFileInfo,
  ThreadInfo,
  ThreadRef,
  TurnDeriveResult,
  TurnRecord,
  ViewCompactParams,
  ViewContentsReport,
  ViewStatus,
} from "./types.js";

export { DEFAULT_PROMPT_NAMES, PROMPT_NAMES } from "../shared/prompts/index.js";
export { estimateTokens, TOKEN_ESTIMATOR_ID } from "../shared/token_counting/index.js";
export * from "./types.js";

export type LhcExecutor = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;

export const BUILT_IN_PROFILES = [
  { name: "continuation", lowerBound: 120_000, percentages: { full: 30, smooth: 30, detailed: 20, brief: 20 } },
  { name: "conversation", lowerBound: 120_000, percentages: { full: 12, smooth: 48, detailed: 20, brief: 20 } },
  { name: "coding", lowerBound: 120_000, percentages: { full: 25, smooth: 35, detailed: 20, brief: 20 } },
] as const;
export const DEFAULT_VISIBILITY = { maxTokens: 64_000, targetTokens: 32_000 } as const;
export const DEFAULT_COMPACT_THRESHOLD = 160_000;

const ASSIGNMENT_KINDS = new Set([
  "smoothed_prompt",
  "tool_result_summary",
  "detailed_turn_compression",
  "chunk_summary_brief",
]);

function requirePositive(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new TypeError(`initLhc config: ${name} must be a positive number, got ${String(value)}`);
  }
}

function validateConfig(config: SdkConfig): void {
  if (config.componentInstanceId.trim() === "") {
    throw new TypeError("initLhc config: componentInstanceId must be non-empty");
  }
  if (config.mode !== "background" && config.mode !== "manual") {
    throw new TypeError(`initLhc config: mode must be "background" or "manual", got ${JSON.stringify(config.mode)}`);
  }
  if (String(config.inference?.call ?? "").trim() === "") {
    throw new TypeError("initLhc config: inference.call must be a function handle");
  }
  for (const [kind, assignment] of Object.entries(config.inference.assignments ?? {})) {
    if (!ASSIGNMENT_KINDS.has(kind)) {
      throw new TypeError(`initLhc config: inference.assignments has unknown derivation type "${kind}"`);
    }
    for (const field of ["provider", "model", "prompt"] as const) {
      if (typeof assignment[field] !== "string" || assignment[field].trim() === "") {
        throw new TypeError(`initLhc config: inference.assignments.${kind}.${field} must be a non-empty string`);
      }
    }
    if (!(VALID_PROMPT_NAMES as readonly string[]).includes(assignment.prompt)) {
      throw new TypeError(
        `initLhc config: inference.assignments.${kind}.prompt names unknown template "${assignment.prompt}"`,
      );
    }
    requirePositive(assignment.targetMinRatio, `inference.assignments.${kind}.targetMinRatio`);
    requirePositive(assignment.targetAimRatio, `inference.assignments.${kind}.targetAimRatio`);
    requirePositive(assignment.targetMaxRatio, `inference.assignments.${kind}.targetMaxRatio`);
    if (
      assignment.targetMinRatio !== undefined &&
      assignment.targetMaxRatio !== undefined &&
      assignment.targetMaxRatio < assignment.targetMinRatio
    ) {
      throw new TypeError(`initLhc config: inference.assignments.${kind}.targetMaxRatio must be >= targetMinRatio`);
    }
  }
  requirePositive(config.inference.timeoutMs, "inference.timeoutMs");
  requirePositive(config.inference.maxInputChars, "inference.maxInputChars");
  requirePositive(config.guards?.smoothedPrompt?.maxInferenceTokens, "guards.smoothedPrompt.maxInferenceTokens");
  requirePositive(config.guards?.smoothedPrompt?.suspiciousOutputRatio, "guards.smoothedPrompt.suspiciousOutputRatio");
  requirePositive(config.guards?.toolResultSummary?.timeoutMs, "guards.toolResultSummary.timeoutMs");
  requirePositive(
    config.guards?.detailedTurnCompression?.tinyTurnTokens,
    "guards.detailedTurnCompression.tinyTurnTokens",
  );
  requirePositive(config.toolResult?.smallTierTokens, "toolResult.smallTierTokens");
  requirePositive(config.toolResult?.smallTargetRatio, "toolResult.smallTargetRatio");
  requirePositive(config.toolResult?.midTargetRatio, "toolResult.midTargetRatio");
  requirePositive(config.chunkPolicy?.targetProjectedTokens, "chunkPolicy.targetProjectedTokens");
  requirePositive(config.chunkPolicy?.maxProjectedTokens, "chunkPolicy.maxProjectedTokens");
  if (
    config.chunkPolicy !== undefined &&
    config.chunkPolicy.maxProjectedTokens < config.chunkPolicy.targetProjectedTokens
  ) {
    throw new TypeError("initLhc config: chunkPolicy.maxProjectedTokens must be >= targetProjectedTokens");
  }
  requirePositive(config.view?.compactThreshold, "view.compactThreshold");
  requirePositive(config.view?.visibility?.maxTokens, "view.visibility.maxTokens");
  requirePositive(config.view?.visibility?.targetTokens, "view.visibility.targetTokens");
  const maxTokens = config.view?.visibility?.maxTokens ?? DEFAULT_VISIBILITY.maxTokens;
  const targetTokens = config.view?.visibility?.targetTokens ?? DEFAULT_VISIBILITY.targetTokens;
  if (maxTokens <= targetTokens) {
    throw new TypeError(
      `initLhc config: view.visibility.maxTokens (${maxTokens}) must be greater than targetTokens (${targetTokens})`,
    );
  }
  const bases = new Map<string, (typeof BUILT_IN_PROFILES)[number]>(
    BUILT_IN_PROFILES.map((profile) => [profile.name, profile]),
  );
  for (const profile of config.view?.profiles ?? []) {
    const base = bases.get(profile.name);
    if (base === undefined && (profile.lowerBound === undefined || profile.percentages === undefined)) {
      throw new TypeError(`initLhc config: view profile "${profile.name}" is partial but overrides no built-in`);
    }
    const lowerBound = profile.lowerBound ?? base?.lowerBound;
    requirePositive(lowerBound, `view profile "${profile.name}" lowerBound`);
    const percentages = { ...(base?.percentages ?? {}), ...(profile.percentages ?? {}) } as Record<string, number>;
    if (["full", "smooth", "detailed", "brief"].some((key) => percentages[key] === undefined)) {
      throw new TypeError(`initLhc config: view profile "${profile.name}" must carry all four percentages`);
    }
    const sum = Object.values(percentages).reduce((total, value) => total + value, 0);
    if (Object.values(percentages).some((value) => !Number.isFinite(value) || value < 0) || sum !== 100) {
      throw new TypeError(
        `initLhc config: view profile "${profile.name}" percentages must be non-negative and sum to 100`,
      );
    }
  }
}

function componentRef(ref: ThreadRef): { threadId?: string; filePath?: string } {
  return "threadId" in ref ? { threadId: ref.threadId } : { filePath: ref.filePath };
}

function storedConfig(config: SdkConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    inference: {
      assignments: config.inference.assignments ?? {},
      ...(config.inference.timeoutMs === undefined ? {} : { timeoutMs: config.inference.timeoutMs }),
      ...(config.inference.maxInputChars === undefined ? {} : { maxInputChars: config.inference.maxInputChars }),
    },
    ...(config.guards === undefined ? {} : { guards: config.guards }),
    ...(config.toolResult === undefined ? {} : { toolResult: config.toolResult }),
    ...(config.chunkPolicy === undefined ? {} : { chunkPolicy: config.chunkPolicy }),
    ...(config.view === undefined ? {} : { view: config.view }),
  };
}

export class Lhc {
  readonly config: SdkConfig;
  readonly scheduler: { mode: "background" | "manual" };
  readonly threads: {
    newThread: (input: NewThreadInput) => Promise<OpResult<{ threadId: string; filePath: string }>>;
    resolve: (input: { threadId: string }) => Promise<OpResult<ThreadInfo>>;
    listThreads: (input?: { cwd?: string }) => Promise<OpResult<ThreadInfo[]>>;
    info: (ref: ThreadRef) => Promise<OpResult<ThreadFileInfo>>;
  };
  readonly intakeStream: {
    messageEvents: (ref: ThreadRef, events: readonly MessageEventInput[]) => Promise<OpResult<BatchResult>>;
    listEvents: (ref: ThreadRef) => Promise<OpResult<EventRecord[]>>;
  };
  readonly messages: {
    list: (ref: ThreadRef, options?: MessageListOptions) => Promise<OpResult<MessageRecord[]>>;
    show: (ref: ThreadRef, messageId: string) => Promise<OpResult<MessageDetail>>;
    report: (
      ref: ThreadRef,
      options?: { notReady?: boolean; messageId?: string },
    ) => Promise<OpResult<DerivationReportEntry[]>>;
    derive: (ref: ThreadRef, messageIds: string[]) => Promise<OpResult<MessageDeriveResult[]>>;
    edit: (ref: ThreadRef, edit: { messageId: string; content: string }) => Promise<OpResult<MutationResult>>;
    remove: (ref: ThreadRef, removal: { messageId: string }) => Promise<OpResult<MutationResult>>;
  };
  readonly turns: {
    listTurns: (ref: ThreadRef) => Promise<OpResult<TurnRecord[]>>;
    listChunks: (ref: ThreadRef) => Promise<OpResult<ChunkRecord[]>>;
    report: (
      ref: ThreadRef,
      options?: { notReady?: boolean; turnId?: string; chunkId?: string },
    ) => Promise<OpResult<DerivationReportEntry[]>>;
    deriveTurn: (ref: ThreadRef, turnId: string) => Promise<OpResult<TurnDeriveResult>>;
    deriveDetailedChunk: (ref: ThreadRef, chunkId: string) => Promise<OpResult<ChunkDeriveResult>>;
    deriveBriefChunk: (ref: ThreadRef, chunkId: string) => Promise<OpResult<ChunkDeriveResult>>;
  };
  readonly threadView: {
    getLlmRequestContext: (ref: ThreadRef) => Promise<OpResult<LlmRequestContext>>;
    getSessionThreadView: (ref: ThreadRef) => Promise<OpResult<SessionThreadView>>;
    status: (ref: ThreadRef) => Promise<OpResult<ViewStatus>>;
    describe: (ref: ThreadRef) => Promise<OpResult<StoredView | null>>;
    previewCompact: (
      ref: ThreadRef,
      options?: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
    ) => Promise<OpResult<PreviewCompactOutcome>>;
    compact: (
      ref: ThreadRef,
      options?: { profile?: string; params?: ViewCompactParams; signal?: { aborted: boolean } },
    ) => Promise<OpResult<CompactReceipt>>;
    prune: (ref: ThreadRef, params?: { targetTokens?: number }) => Promise<OpResult<PruneReceipt>>;
  };
  readonly inspect: {
    overview: (ref: ThreadRef) => Promise<OpResult<InspectOverview>>;
    health: (ref: ThreadRef) => Promise<OpResult<HealthReport>>;
    view: (ref: ThreadRef) => Promise<OpResult<ViewContentsReport>>;
  };
  readonly logging: {
    write: (ref: ThreadRef, entry: LogEntry) => Promise<OpResult<void>>;
    query: (ref: ThreadRef, filter?: Record<string, unknown>) => Promise<OpResult<StoredLogEntry[]>>;
    queryDerivationLog: (
      ref: ThreadRef,
      filter?: Record<string, unknown>,
    ) => Promise<OpResult<StoredDerivationLogEntry[]>>;
  };
  readonly work: {
    drain: (ref: ThreadRef, options?: { maxItems?: number }) => Promise<OpResult<DrainReport>>;
    status: (ref: ThreadRef) => Promise<OpResult<{ queued: number; running: number; drainScheduled: boolean }>>;
    touch: (ref: ThreadRef) => Promise<OpResult<{ scheduled: boolean }>>;
  };

  constructor(
    private readonly component: ComponentApi,
    private readonly executor: LhcExecutor,
    config: SdkConfig,
  ) {
    validateConfig(config);
    this.config = config;
    this.scheduler = { mode: config.mode };
    const instance = config.componentInstanceId;
    const writeConfig = storedConfig(config);
    const modelCallHandle = String(config.inference.call);
    const refArgs = (ref: ThreadRef) => ({ instance, ref: componentRef(ref) });

    this.threads = {
      newThread: async (input) =>
        (await this.executor.runMutation(this.component.threads.newThread, {
          instance,
          config: writeConfig,
          modelCallHandle,
          input,
        })) as OpResult<{ threadId: string; filePath: string }>,
      resolve: async (input) =>
        (await this.executor.runQuery(this.component.threads.resolve, {
          instance,
          threadId: input.threadId,
        })) as OpResult<ThreadInfo>,
      listThreads: async (input) =>
        (await this.executor.runQuery(this.component.threads.list, {
          instance,
          ...(input?.cwd === undefined ? {} : { cwd: input.cwd }),
        })) as OpResult<ThreadInfo[]>,
      info: async (ref) =>
        (await this.executor.runQuery(this.component.threads.info, refArgs(ref))) as OpResult<ThreadFileInfo>,
    };
    this.intakeStream = {
      messageEvents: async (ref, events) =>
        (await this.executor.runMutation(this.component.intake.messageEvents, {
          ...refArgs(ref),
          config: writeConfig,
          modelCallHandle,
          events: [...events],
        })) as OpResult<BatchResult>,
      listEvents: async (ref) =>
        (await this.executor.runQuery(this.component.intake.listEvents, refArgs(ref))) as OpResult<EventRecord[]>,
    };
    this.messages = {
      list: async (ref, options) =>
        (await this.executor.runQuery(this.component.records.listMessages, {
          ...refArgs(ref),
          ...(options === undefined ? {} : { options }),
        })) as OpResult<MessageRecord[]>,
      show: async (ref, messageId) =>
        (await this.executor.runQuery(this.component.records.showMessage, {
          ...refArgs(ref),
          messageId,
        })) as OpResult<MessageDetail>,
      report: async (ref, options) =>
        (await this.executor.runQuery(this.component.records.reportDerivations, {
          ...refArgs(ref),
          scope: "message",
          ...(options?.messageId === undefined ? {} : { subject: options.messageId }),
          ...(options?.notReady === undefined ? {} : { notReady: options.notReady }),
        })) as OpResult<DerivationReportEntry[]>,
      derive: async (ref, messageIds) =>
        (await this.executor.runAction(this.component.work.deriveMessages, {
          ...refArgs(ref),
          messageIds,
        })) as OpResult<MessageDeriveResult[]>,
      edit: async (ref, edit) =>
        (await this.executor.runMutation(this.component.records.editMessage, {
          ...refArgs(ref),
          ...edit,
        })) as OpResult<MutationResult>,
      remove: async (ref, removal) =>
        (await this.executor.runMutation(this.component.records.removeMessage, {
          ...refArgs(ref),
          ...removal,
        })) as OpResult<MutationResult>,
    };
    this.turns = {
      listTurns: async (ref) =>
        (await this.executor.runQuery(this.component.records.listTurns, refArgs(ref))) as OpResult<TurnRecord[]>,
      listChunks: async (ref) =>
        (await this.executor.runQuery(this.component.records.listChunks, refArgs(ref))) as OpResult<ChunkRecord[]>,
      report: async (ref, options) => {
        const scope = options?.chunkId === undefined ? "turn" : "chunk";
        return (await this.executor.runQuery(this.component.records.reportDerivations, {
          ...refArgs(ref),
          scope,
          ...(options?.chunkId === undefined && options?.turnId === undefined
            ? {}
            : { subject: options.chunkId ?? options.turnId }),
          ...(options?.notReady === undefined ? {} : { notReady: options.notReady }),
        })) as OpResult<DerivationReportEntry[]>;
      },
      deriveTurn: async (ref, turnId) =>
        (await this.executor.runAction(this.component.work.deriveTurn, {
          ...refArgs(ref),
          turnId,
        })) as OpResult<TurnDeriveResult>,
      deriveDetailedChunk: async (ref, chunkId) =>
        (await this.executor.runAction(this.component.work.deriveChunk, {
          ...refArgs(ref),
          chunkId,
          derivationType: "chunk_summary_detailed",
        })) as OpResult<ChunkDeriveResult>,
      deriveBriefChunk: async (ref, chunkId) =>
        (await this.executor.runAction(this.component.work.deriveChunk, {
          ...refArgs(ref),
          chunkId,
          derivationType: "chunk_summary_brief",
        })) as OpResult<ChunkDeriveResult>,
    };
    this.threadView = {
      getLlmRequestContext: async (ref) =>
        (await this.executor.runQuery(
          this.component.view.getLlmRequestContext,
          refArgs(ref),
        )) as OpResult<LlmRequestContext>,
      getSessionThreadView: async (ref) =>
        (await this.executor.runQuery(
          this.component.view.getSessionThreadView,
          refArgs(ref),
        )) as OpResult<SessionThreadView>,
      status: async (ref) =>
        (await this.executor.runQuery(this.component.view.status, refArgs(ref))) as OpResult<ViewStatus>,
      describe: async (ref) =>
        (await this.executor.runQuery(this.component.view.describe, refArgs(ref))) as OpResult<StoredView | null>,
      previewCompact: async (ref, options) =>
        (await this.executor.runQuery(this.component.view.previewCompact, {
          ...refArgs(ref),
          ...(options?.profile === undefined ? {} : { profile: options.profile }),
          ...(options?.params === undefined ? {} : { params: options.params }),
          ...(options?.signal === undefined ? {} : { aborted: options.signal.aborted }),
        })) as OpResult<PreviewCompactOutcome>,
      compact: async (ref, options) =>
        (await this.executor.runMutation(this.component.view.compact, {
          ...refArgs(ref),
          ...(options?.profile === undefined ? {} : { profile: options.profile }),
          ...(options?.params === undefined ? {} : { params: options.params }),
          ...(options?.signal === undefined ? {} : { aborted: options.signal.aborted }),
        })) as OpResult<CompactReceipt>,
      prune: async (ref, params) =>
        (await this.executor.runMutation(this.component.view.prune, {
          ...refArgs(ref),
          ...(params?.targetTokens === undefined ? {} : { targetTokens: params.targetTokens }),
        })) as OpResult<PruneReceipt>,
    };
    this.inspect = {
      overview: async (ref) =>
        (await this.executor.runQuery(this.component.inspect.overview, refArgs(ref))) as OpResult<InspectOverview>,
      health: async (ref) =>
        (await this.executor.runQuery(this.component.inspect.health, refArgs(ref))) as OpResult<HealthReport>,
      view: async (ref) =>
        (await this.executor.runQuery(this.component.inspect.view, refArgs(ref))) as OpResult<ViewContentsReport>,
    };
    this.logging = {
      write: async (ref, entry) => {
        const result = (await this.executor.runMutation(this.component.logging.write, {
          ...refArgs(ref),
          entry,
        })) as OpResult<null>;
        return result.ok ? { ok: true as const, value: undefined } : result;
      },
      query: async (ref, filter) =>
        (await this.executor.runQuery(this.component.logging.list, {
          ...refArgs(ref),
          ...(filter === undefined ? {} : { filter }),
        })) as OpResult<StoredLogEntry[]>,
      queryDerivationLog: async (ref, filter) =>
        (await this.executor.runQuery(this.component.logging.listDerivation, {
          ...refArgs(ref),
          ...(filter === undefined ? {} : { filter }),
        })) as OpResult<StoredDerivationLogEntry[]>,
    };
    this.work = {
      drain: async (ref, options) =>
        (await this.executor.runAction(this.component.work.drain, {
          ...refArgs(ref),
          ...(options?.maxItems === undefined ? {} : { maxItems: options.maxItems }),
        })) as OpResult<DrainReport>,
      status: async (ref) =>
        (await this.executor.runQuery(this.component.work.status, refArgs(ref))) as OpResult<{
          queued: number;
          running: number;
          drainScheduled: boolean;
        }>,
      touch: async (ref) =>
        (await this.executor.runMutation(this.component.work.touch, refArgs(ref))) as OpResult<{ scheduled: boolean }>,
    };
  }

  async drainSettled(ref: ThreadRef): Promise<void> {
    for (;;) {
      const status = await this.work.status(ref);
      if (!status.ok || (status.value.queued === 0 && !status.value.drainScheduled)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export function initLhc(component: ComponentApi, executor: LhcExecutor, config: SdkConfig): Lhc {
  return new Lhc(component, executor, config);
}
