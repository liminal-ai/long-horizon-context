import { join } from "node:path";
import {
  type BatchResult,
  type CompactReceipt,
  createDeterministicInferenceCallbacks,
  type DerivationReportEntry,
  type HealthReport,
  type InferenceConfig,
  type InspectOverview,
  initLhc,
  type Lhc,
  type LlmRequestContext,
  type MessageEventInput,
  type MutationResult,
  type OpResult,
  type SdkConfig,
  type ViewContentsReport,
  type ViewStatus,
} from "../../src/index.js";
import { type TempStore, validEvent } from "./index.js";

export const LIFECYCLE_PROFILE = {
  name: "lifecycle",
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
} as const;

export function createLifecycleSdk(inference?: InferenceConfig, guards?: SdkConfig["guards"]): Lhc {
  return initLhc({
    tokenFamily: "o200k",
    ...(inference !== undefined ? { inference } : { inferenceCallbacks: createDeterministicInferenceCallbacks() }),
    mode: "background",
    ...(guards === undefined ? {} : { guards }),
    chunkPolicy: { targetProjectedTokens: 90, maxProjectedTokens: 4400 },
    toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
    view: {
      profiles: [{ ...LIFECYCLE_PROFILE, percentages: { ...LIFECYCLE_PROFILE.percentages } }],
      compactThreshold: 300,
    },
  });
}

const TURN_COUNT = 12;
const TOOL_HEAVY_TURNS = new Set([5, 6, 7, 8]);
const TURNS_PER_BATCH = 3;

export const EDIT_TARGET = { turnId: "t12", kind: "user_prompt" } as const;
export const EDITED_MESSAGE_TEXT = "turn 12 revised: drop area 12 and re-check area 5 instead";
export const DELETE_TARGET = { turnId: "t10", kind: "assistant_text" } as const;
export const DELETED_MESSAGE_TEXT = "findings for area 10";

function turnEvents(turn: number): MessageEventInput[] {
  let seq = 0;
  const key = (): string => {
    seq += 1;
    return `lc-t${turn}-e${seq}`;
  };
  const events: MessageEventInput[] = [
    validEvent("user_prompt", {
      idempotencyKey: key(),
      payload: { text: `turn ${turn}: please investigate area ${turn}` },
    }),
    validEvent("assistant_thinking", {
      idempotencyKey: key(),
      payload: { text: `considering what area ${turn} contains` },
    }),
  ];
  if (TOOL_HEAVY_TURNS.has(turn)) {
    for (const run of [1, 2]) {
      const toolCallId = `call-lc-${turn}-${run}`;
      events.push(
        validEvent("tool_call", {
          idempotencyKey: key(),
          payload: {
            toolCallId,
            toolName: "read_file",
            arguments: { path: `area-${turn}/file-${run}.txt` },
          },
        }),
        validEvent("tool_result", {
          idempotencyKey: key(),
          payload: {
            toolCallId,
            content: `contents of area-${turn}/file-${run}.txt: detail ${turn}.${run} with enough text to summarize`,
            isError: false,
          },
        }),
      );
    }
  }
  events.push(
    validEvent("assistant_text", {
      idempotencyKey: key(),
      payload: { text: `findings for area ${turn}` },
    }),
    validEvent("turn_end", { idempotencyKey: key() }),
  );
  return events;
}

function intakeBatches(): MessageEventInput[][] {
  const batches: MessageEventInput[][] = [];
  for (let first = 1; first <= TURN_COUNT; first += TURNS_PER_BATCH) {
    const batch: MessageEventInput[] = [];
    for (let turn = first; turn < first + TURNS_PER_BATCH && turn <= TURN_COUNT; turn += 1) {
      batch.push(...turnEvents(turn));
    }
    batches.push(batch);
  }
  return batches;
}

export interface LifecyclePhases {
  create: OpResult<{ threadId: string; filePath: string }>;
  intake: Array<OpResult<BatchResult>>;
  drain: { settled: true };
  status: OpResult<ViewStatus>;
  compact1: OpResult<CompactReceipt>;
  llmContext1: OpResult<LlmRequestContext>;
  inspect1: {
    overview: OpResult<InspectOverview>;
    view: OpResult<ViewContentsReport>;
    health: OpResult<HealthReport>;
  };
  mutate: {
    editedMessageId: string;
    deletedMessageId: string;
    edit: OpResult<MutationResult>;
    delete: OpResult<MutationResult>;
    healthAfterMutate: OpResult<HealthReport>;
    messagesNotReady: OpResult<DerivationReportEntry[]>;
    turnsNotReady: OpResult<DerivationReportEntry[]>;
  };
  rebuild: { settled: true };
  health2: OpResult<HealthReport>;
  compact2: OpResult<CompactReceipt>;
  llmContext2: OpResult<LlmRequestContext>;
  materialize: OpResult<{ writtenPath: string }>;
}

export type LifecycleCheckpoint = "inspect1" | "health2" | "materialize";

export interface LifecycleOptions {
  name?: string;
  freshSdkBetweenGroups?: boolean;
  onCheckpoint?: (checkpoint: LifecycleCheckpoint, ctx: { sdk: Lhc; filePath: string }) => Promise<void>;
  inference?: InferenceConfig;
  guards?: SdkConfig["guards"];
}

export interface LifecycleRun {
  filePath: string;
  outPath: string;
  threadId: string;
  phases: LifecyclePhases;
}

function expectOk<T>(result: OpResult<T>, phase: string): T {
  if (!result.ok) {
    throw new Error(`lifecycle ${phase} failed: ${result.error.code} — ${result.error.reason}`);
  }
  return result.value;
}

export async function runLifecycle(store: TempStore, opts: LifecycleOptions = {}): Promise<LifecycleRun> {
  const name = opts.name ?? "lifecycle";
  const filePath = store.threadPath(name);
  const outPath = join(store.dir, `${name}-session.jsonl`);
  const ref = { filePath };

  let sdk = createLifecycleSdk(opts.inference, opts.guards);
  const nextGroup = (): void => {
    if (opts.freshSdkBetweenGroups) sdk = createLifecycleSdk(opts.inference, opts.guards);
  };
  const checkpoint = async (cp: LifecycleCheckpoint): Promise<void> => {
    if (opts.onCheckpoint !== undefined) await opts.onCheckpoint(cp, { sdk, filePath });
  };

  const create = await sdk.threads.newThread({
    filePath,
    registryPath: store.registryPath,
  });
  const threadId = expectOk(create, "create").threadId;

  const intake: Array<OpResult<BatchResult>> = [];
  for (const batch of intakeBatches()) {
    const sent = await sdk.intakeStream.messageEvents(ref, batch);
    intake.push(sent);
    expectOk(sent, "intake");
  }

  await sdk.drainSettled(ref);
  const drain = { settled: true } as const;

  const status = await sdk.threadView.status(ref);
  expectOk(status, "status");

  nextGroup();
  const compact1 = await sdk.threadView.compact(ref, { profile: LIFECYCLE_PROFILE.name });
  expectOk(compact1, "compact1");
  const llmContext1 = await sdk.threadView.getLlmRequestContext(ref);
  expectOk(llmContext1, "llmContext1");
  const inspect1 = {
    overview: await sdk.inspect.overview(ref),
    view: await sdk.inspect.view(ref),
    health: await sdk.inspect.health(ref),
  };
  expectOk(inspect1.overview, "inspect1.overview");
  expectOk(inspect1.view, "inspect1.view");
  expectOk(inspect1.health, "inspect1.health");
  await checkpoint("inspect1");

  nextGroup();
  const listed = expectOk(await sdk.messages.list(ref), "mutate.list");
  const editTarget = listed.find((record) => record.kind === EDIT_TARGET.kind && record.turnId === EDIT_TARGET.turnId);
  const deleteTarget = listed.find(
    (record) => record.kind === DELETE_TARGET.kind && record.turnId === DELETE_TARGET.turnId,
  );
  if (editTarget === undefined || deleteTarget === undefined) {
    throw new Error("lifecycle invariant: edit/delete targets not found in the record");
  }
  const edit = await sdk.messages.edit(ref, {
    messageId: editTarget.messageId,
    content: EDITED_MESSAGE_TEXT,
  });
  expectOk(edit, "mutate.edit");
  const deleted = await sdk.messages.remove(ref, { messageId: deleteTarget.messageId });
  expectOk(deleted, "mutate.delete");
  const mutate: LifecyclePhases["mutate"] = {
    editedMessageId: editTarget.messageId,
    deletedMessageId: deleteTarget.messageId,
    edit,
    delete: deleted,
    healthAfterMutate: await sdk.inspect.health(ref),
    messagesNotReady: await sdk.messages.report(ref, { notReady: true }),
    turnsNotReady: await sdk.turns.report(ref, { notReady: true }),
  };
  expectOk(mutate.healthAfterMutate, "mutate.health");
  expectOk(mutate.messagesNotReady, "mutate.messagesNotReady");
  expectOk(mutate.turnsNotReady, "mutate.turnsNotReady");

  await sdk.drainSettled(ref);
  const rebuild = { settled: true } as const;

  const health2 = await sdk.inspect.health(ref);
  expectOk(health2, "health2");
  await checkpoint("health2");

  nextGroup();
  const compact2 = await sdk.threadView.compact(ref, { profile: LIFECYCLE_PROFILE.name });
  expectOk(compact2, "compact2");
  const llmContext2 = await sdk.threadView.getLlmRequestContext(ref);
  expectOk(llmContext2, "llmContext2");
  const materialize = await sdk.threadView.materialize(ref, { path: outPath });
  expectOk(materialize, "materialize");
  await checkpoint("materialize");

  return {
    filePath,
    outPath,
    threadId,
    phases: {
      create,
      intake,
      drain,
      status,
      compact1,
      llmContext1,
      inspect1,
      mutate,
      rebuild,
      health2,
      compact2,
      llmContext2,
      materialize,
    },
  };
}
