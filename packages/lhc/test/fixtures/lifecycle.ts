// The Epic 04 lifecycle script (Story 4, Flow 5): every built v1 surface
// driven once, in PI-extension call order, against one real SDK
// configuration with deterministic inference callbacks — zero network, zero
// model calls, no mocks anywhere. The script owns the sequence and the phase
// names (tech design Flow 5); assertions live in the driving tests, so the
// replay, teardown, and process legs all run THIS sequence rather than a
// re-described one (DD-8).
//
// Phases: create | intake | drain | status | compact1 | pull1 | inspect1 |
// mutate | rebuild | health2 | compact2 | pull2 | materialize.
//
// Mode is background — the production posture the PI extension will run —
// and the drain/rebuild phases settle through `drainSettled`, the real
// background awaitable. The post-mutation health snapshot (AC-5.2's
// "cleared set pending") is deterministic because every SDK operation here
// is synchronous SQLite chained through microtasks, while a background
// drain pass always starts on a macrotask (scheduler runLoop defers through
// setImmediate): the edit → delete → health reads inside the mutate phase
// run as one unbroken microtask cascade and complete before the poked drain
// can claim its first item. The rebuild phase then yields via drainSettled
// and the drain runs to empty.
import { join } from "node:path";
import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type BatchResult,
  type InferenceConfig,
  type CompactReceipt,
  type DerivationReportEntry,
  type HealthReport,
  type InspectOverview,
  type Lhc,
  type MessageEventInput,
  type MutationResult,
  type OpResult,
  type PullResult,
  type ViewContentsReport,
  type ViewStatus,
} from "../../src/index.js";
import { validEvent, type TempStore } from "./index.js";

// ── the one SDK configuration (AC-5.1) ────────────────────────────
//
// Deterministic callbacks injected at construction (the only direct-callback
// path since the CLI retired), background mode, zero-backoff retry so a
// deterministic run never arms a wake timer, the Epic 03 fixture's pinned
// chunk policy (12 fixed-shape turns cut into 4 chunks, c1–c3 closed), and
// a named "lifecycle" profile so compact runs profile-addressed (story
// scope: "compact (profile)") with all three lower bands non-empty on this
// thread (Epic 03 Story 2's reference gradient).
export const LIFECYCLE_PROFILE = {
  name: "lifecycle",
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
} as const;

// Epic 05 TC-4.2: the capstone replays this exact sequence with the real
// inference adapter — the inference-callback slot is the one swap point; the
// sequence, phase names, and every other configuration value stay owned here
// so the deterministic leg and the real leg run THE SAME lifecycle.
export function createLifecycleSdk(inference?: InferenceConfig): Lhc {
  return initLhc({
    ...(inference !== undefined
      ? { inference }
      : { inferenceCallbacks: createDeterministicInferenceCallbacks() }),
    mode: "background",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    chunkPolicy: { targetProjectedTokens: 90, maxProjectedTokens: 4400 },
    view: {
      profiles: [{ ...LIFECYCLE_PROFILE, percentages: { ...LIFECYCLE_PROFILE.percentages } }],
      // Low threshold so the status checkpoint genuinely recommends the
      // compact the sequence performs next.
      compactThreshold: 300,
    },
  });
}

// ── the recorded conversation ─────────────────────────────────────
//
// Same shape and text profile as the Epic 03 derived-thread fixture (12
// turns, tool-heavy middle 5–8, two tool runs each) so the pinned chunk
// policy cuts the same 4-chunk shape — but with explicit per-run
// idempotency keys so a replay on a fresh thread records byte-identical
// event payloads regardless of any process-global fixture counters.
const TURN_COUNT = 12;
const TOOL_HEAVY_TURNS = new Set([5, 6, 7, 8]);
const TURNS_PER_BATCH = 3; // multi-turn batches (story scope)

// Mutation targets: both in the post-compact tail (compact point at t9's
// start under the lifecycle profile), so the second compact's pull shows the
// edit verbatim and the deletion's absence — the tail is full fidelity.
export const EDIT_TARGET = { turnId: "t12", kind: "user_prompt" } as const;
export const EDITED_MESSAGE_TEXT =
  "turn 12 revised: drop area 12 and re-check area 5 instead";
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

// ── run shape ─────────────────────────────────────────────────────

export interface LifecyclePhases {
  create: OpResult<{ threadId: string; filePath: string }>;
  intake: Array<OpResult<BatchResult>>;
  drain: { settled: true };
  status: OpResult<ViewStatus>;
  compact1: OpResult<CompactReceipt>;
  pull1: OpResult<PullResult>;
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
    // Captured inside the mutate phase, before the background drain's first
    // macrotask: the cleared-set-pending evidence (AC-5.2).
    healthAfterMutate: OpResult<HealthReport>;
    messagesNotReady: OpResult<DerivationReportEntry[]>;
    turnsNotReady: OpResult<DerivationReportEntry[]>;
  };
  rebuild: { settled: true };
  health2: OpResult<HealthReport>;
  compact2: OpResult<CompactReceipt>;
  pull2: OpResult<PullResult>;
  materialize: OpResult<{ writtenPath: string }>;
}

export type LifecycleCheckpoint = "inspect1" | "health2" | "materialize";

export interface LifecycleOptions {
  // Distinguishes the thread file and materialize target so replay and
  // teardown legs run side by side in one store (same dir ⇒ same header cwd).
  name?: string;
  // TC-5.3: a fresh initLhc between the intake / compact / mutation /
  // render phase groups — every group boundary is a quiescent point (no
  // queued work, no running drain), so the abandoned instance can never act
  // after its group ends.
  freshSdkBetweenGroups?: boolean;
  // TC-5.4: spawned-CLI parity probes at the three read checkpoints.
  onCheckpoint?: (
    checkpoint: LifecycleCheckpoint,
    ctx: { sdk: Lhc; filePath: string },
  ) => Promise<void>;
  // Epic 05 TC-4.2: run the sequence on the model-call inference path instead
  // of deterministic inference callbacks. Same configuration otherwise (see
  // createLifecycleSdk).
  inference?: InferenceConfig;
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

// ── the sequence ──────────────────────────────────────────────────

export async function runLifecycle(
  store: TempStore,
  opts: LifecycleOptions = {},
): Promise<LifecycleRun> {
  const name = opts.name ?? "lifecycle";
  const filePath = store.threadPath(name);
  const outPath = join(store.dir, `${name}-session.jsonl`);
  const ref = { filePath };

  let sdk = createLifecycleSdk(opts.inference);
  const nextGroup = (): void => {
    // The fresh instance is the same configuration assembled again — the
    // continuity proof is that no phase depends on the prior instance's
    // memory, only on the thread file.
    if (opts.freshSdkBetweenGroups) sdk = createLifecycleSdk(opts.inference);
  };
  const checkpoint = async (cp: LifecycleCheckpoint): Promise<void> => {
    if (opts.onCheckpoint !== undefined) await opts.onCheckpoint(cp, { sdk, filePath });
  };

  // ── group 1: create → intake → drain → status ──
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

  // Background drain settles (story scope): the intake pokes scheduled the
  // work; this is the await that lets the scheduler run it to empty.
  await sdk.drainSettled(ref);
  const drain = { settled: true } as const;

  const status = await sdk.threadView.status(ref);
  expectOk(status, "status");

  // ── group 2: compact1 → pull1 → inspect1 ──
  nextGroup();
  const compact1 = await sdk.threadView.compact(ref, { profile: LIFECYCLE_PROFILE.name });
  expectOk(compact1, "compact1");
  const pull1 = await sdk.threadView.pull(ref);
  expectOk(pull1, "pull1");
  const inspect1 = {
    overview: await sdk.inspect.overview(ref),
    view: await sdk.inspect.view(ref),
    health: await sdk.inspect.health(ref),
  };
  expectOk(inspect1.overview, "inspect1.overview");
  expectOk(inspect1.view, "inspect1.view");
  expectOk(inspect1.health, "inspect1.health");
  await checkpoint("inspect1");

  // ── group 3: mutate → rebuild → health2 ──
  nextGroup();
  const listed = expectOk(await sdk.messages.listMessages(ref), "mutate.list");
  const editTarget = listed.find(
    (record) => record.kind === EDIT_TARGET.kind && record.turnId === EDIT_TARGET.turnId,
  );
  const deleteTarget = listed.find(
    (record) => record.kind === DELETE_TARGET.kind && record.turnId === DELETE_TARGET.turnId,
  );
  if (editTarget === undefined || deleteTarget === undefined) {
    throw new Error("lifecycle invariant: edit/delete targets not found in the record");
  }
  // Edit, delete, and the pending-state reads run in one microtask cascade
  // (see module header): the snapshot is taken before the poked background
  // drain starts its first pass.
  const edit = await sdk.messages.edit(ref, {
    messageId: editTarget.messageId,
    content: EDITED_MESSAGE_TEXT,
  });
  expectOk(edit, "mutate.edit");
  const deleted = await sdk.messages.deleteMessage(ref, { messageId: deleteTarget.messageId });
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

  // Rebuild drains: the mutations' pokes already scheduled the cascade
  // rebuilds on THIS instance's scheduler; settle is the production await.
  await sdk.drainSettled(ref);
  const rebuild = { settled: true } as const;

  const health2 = await sdk.inspect.health(ref);
  expectOk(health2, "health2");
  await checkpoint("health2");

  // ── group 4: compact2 → pull2 → materialize ──
  nextGroup();
  const compact2 = await sdk.threadView.compact(ref, { profile: LIFECYCLE_PROFILE.name });
  expectOk(compact2, "compact2");
  const pull2 = await sdk.threadView.pull(ref);
  expectOk(pull2, "pull2");
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
      pull1,
      inspect1,
      mutate,
      rebuild,
      health2,
      compact2,
      pull2,
      materialize,
    },
  };
}
