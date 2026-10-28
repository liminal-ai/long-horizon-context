import { DatabaseSync } from "node:sqlite";
import {
  type CompactReceipt,
  type DerivationReportEntry,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type MutationResult,
} from "../../src/index.js";
import { corruptTwoOpenTurns } from "./corrupt.js";
import { type TempStore, validEvent } from "./index.js";
import { createInferenceCallbacksDouble, type InferenceCallbacksDouble } from "./inference-callbacks-double.js";
import { type ChunkSnapshot, readChunks } from "./threads.js";

export const RATE_LIMIT_FAILURE_REASON = "rate_limit: scripted failure (fixture)";
export const PERMANENT_FAILURE_REASON = "content_refusal: scripted permanent failure (fixture)";

const FIXTURE_CHUNK_POLICY = { targetProjectedTokens: 90, maxProjectedTokens: 4400 };

const TURN_COUNT = 12;
const TOOL_HEAVY_TURNS = new Set([5, 6, 7, 8]);

function turnEvents(turn: number): MessageEventInput[] {
  const events: MessageEventInput[] = [
    validEvent("user_prompt", {
      payload: { text: `turn ${turn}: please investigate area ${turn}` },
    }),
    validEvent("assistant_thinking", {
      payload: { text: `considering what area ${turn} contains` },
    }),
  ];
  if (TOOL_HEAVY_TURNS.has(turn)) {
    for (const run of [1, 2]) {
      const toolCallId = `call-fx-${turn}-${run}`;
      events.push(
        validEvent("tool_call", {
          payload: {
            toolCallId,
            toolName: "read_file",
            arguments: { path: `area-${turn}/file-${run}.txt` },
          },
        }),
        validEvent("tool_result", {
          payload: {
            toolCallId,
            content: `contents of area-${turn}/file-${run}.txt: detail ${turn}.${run} with enough text to summarize`,
            isError: false,
          },
        }),
      );
    }
  }
  events.push(validEvent("assistant_text", { payload: { text: `findings for area ${turn}` } }), validEvent("turn_end"));
  return events;
}

export interface DerivedThreadFixture {
  filePath: string;
  sdk: Lhc;
  double: InferenceCallbacksDouble;
  turnIds: string[];
  chunks: ChunkSnapshot;
  failedTransientMessageId?: string;
  failedPermanentMessageId?: string;
}

export interface DerivedThreadOptions {
  failures?: boolean;
}

async function send(sdk: Lhc, filePath: string, batch: readonly MessageEventInput[]): Promise<string[]> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
  return result.value.events.map((entry) => entry.messageId ?? "");
}

async function drain(sdk: Lhc, filePath: string): Promise<void> {
  const report = await sdk.work.drain({ filePath });
  if (!report.ok) throw new Error(`fixture drain failed: ${report.error.reason}`);
  if (report.value.stoppedBecause !== "empty" || report.value.remaining !== 0) {
    throw new Error(
      `fixture drain left work behind (stopped: ${report.value.stoppedBecause}, remaining: ${report.value.remaining})`,
    );
  }
}

function failedEntries(entries: readonly DerivationReportEntry[], reason: string): DerivationReportEntry[] {
  return entries.filter((entry) => entry.state === "failed" && entry.reason === reason);
}

function setMessageDerivationFailed(filePath: string, subjectId: string, reason: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.prepare(
      `UPDATE derivation
       SET state = 'failed', content = NULL, reason = ?, metadata = NULL, derived_at = ?
       WHERE subject_kind = 'message' AND subject_id = ?
         AND derivation_type = 'tool_result_summary'`,
    ).run(reason, "2026-01-01T00:00:00.000Z", subjectId);
  } finally {
    db.close();
  }
}

export async function derivedThreadFixture(
  store: TempStore,
  opts: DerivedThreadOptions = {},
): Promise<DerivedThreadFixture> {
  const failures = opts.failures ?? true;

  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({
    tokenFamily: "o200k",
    inferenceCallbacks: double,
    mode: "manual",
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: FIXTURE_CHUNK_POLICY,
    toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
  });

  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);

  const turnIds: string[] = [];
  const fixture: DerivedThreadFixture = {
    filePath,
    sdk,
    double,
    turnIds,
    chunks: { chunks: [], members: [] },
  };

  for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
    if (failures && turn === 6) {
      double.failKind("tool_result_summary", 1, {
        reason: RATE_LIMIT_FAILURE_REASON,
      });
    }
    if (failures && turn === 7) {
      double.failKind("tool_result_summary", 1, {
        reason: PERMANENT_FAILURE_REASON,
      });
    }
    const messageIds = await send(sdk, filePath, turnEvents(turn));
    const firstToolResultId = messageIds[3];
    if (failures && (turn === 6 || turn === 7)) {
      if (firstToolResultId === undefined || firstToolResultId === "") {
        throw new Error(`fixture invariant: turn ${turn} carries no first tool result message`);
      }
      if (turn === 6) fixture.failedTransientMessageId = firstToolResultId;
      else fixture.failedPermanentMessageId = firstToolResultId;
    }
    await drain(sdk, filePath);

    turnIds.push(`t${turn}`);
  }

  fixture.chunks = readChunks(filePath);
  if (fixture.chunks.chunks.length !== 4) {
    throw new Error(
      `fixture invariant: expected 4 chunks, got ${fixture.chunks.chunks.length} — re-pin FIXTURE_CHUNK_POLICY`,
    );
  }
  const closed = fixture.chunks.chunks.filter((chunk) => chunk.status === "closed").length;
  if (closed !== 3) {
    throw new Error(`fixture invariant: expected 3 closed chunks, got ${closed} closed — re-pin FIXTURE_CHUNK_POLICY`);
  }

  if (failures) {
    if (fixture.failedTransientMessageId !== undefined) {
      setMessageDerivationFailed(filePath, fixture.failedTransientMessageId, RATE_LIMIT_FAILURE_REASON);
    }
    if (fixture.failedPermanentMessageId !== undefined) {
      setMessageDerivationFailed(filePath, fixture.failedPermanentMessageId, PERMANENT_FAILURE_REASON);
    }
    const report = await sdk.messages.report({ filePath });
    if (!report.ok) throw new Error(`fixture report failed: ${report.error.reason}`);
    const transient = failedEntries(report.value, RATE_LIMIT_FAILURE_REASON);
    const permanent = failedEntries(report.value, PERMANENT_FAILURE_REASON);
    if (
      transient.length !== 1 ||
      transient[0]?.subjectId !== fixture.failedTransientMessageId ||
      permanent.length !== 1 ||
      permanent[0]?.subjectId !== fixture.failedPermanentMessageId
    ) {
      throw new Error(
        `fixture invariant: expected exactly one transient-failed and one permanent-failed tool_result_summary on the named subjects`,
      );
    }
  }

  return fixture;
}

export async function corruptedVariantThread(store: TempStore): Promise<{ filePath: string; sdk: Lhc }> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({
    tokenFamily: "o200k",
    inferenceCallbacks: double,
    mode: "manual",
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
  });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  for (let turn = 1; turn <= 3; turn += 1) {
    await send(sdk, filePath, turnEvents(turn));
  }
  await drain(sdk, filePath);
  await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "left open before the damage" } })]);
  corruptTwoOpenTurns(filePath);
  return { filePath, sdk };
}

export interface MutationInFlightFixture extends DerivedThreadFixture {
  compactReceipt: CompactReceipt;
  editedMessageId: string;
  mutation: MutationResult;
}

export async function mutationInFlightVariant(store: TempStore): Promise<MutationInFlightFixture> {
  const fixture = await derivedThreadFixture(store, { failures: false });
  const { sdk, filePath } = fixture;

  const compacted = await sdk.threadView.compact({ filePath }, {});
  if (!compacted.ok) {
    throw new Error(`fixture compact failed: ${compacted.error.reason}`);
  }

  const listed = await sdk.messages.list({ filePath });
  if (!listed.ok) throw new Error(`fixture list failed: ${listed.error.reason}`);
  const target = listed.value.find((record) => record.kind === "user_prompt" && record.turnId === "t2");
  if (target === undefined) {
    throw new Error("fixture invariant: turn 2 carries no prompt message");
  }

  const edited = await sdk.messages.edit(
    { filePath },
    { messageId: target.messageId, content: "turn 2 revised: investigate area 2 again" },
  );
  if (!edited.ok) throw new Error(`fixture edit failed: ${edited.error.reason}`);

  return {
    ...fixture,
    compactReceipt: compacted.value,
    editedMessageId: target.messageId,
    mutation: edited.value,
  };
}

export interface MixedStateFixture extends DerivedThreadFixture {
  blockedTurnId: string;
  pendingPromptMessageId: string;
}

export async function mixedStateVariantThread(store: TempStore): Promise<MixedStateFixture> {
  const fixture = await derivedThreadFixture(store);
  const { sdk, filePath } = fixture;

  await send(sdk, filePath, turnEvents(13));

  const promptIds = await send(sdk, filePath, [
    validEvent("user_prompt", {
      payload: { text: "turn 14: this prompt's smoothing stays pending" },
    }),
  ]);
  const pendingPromptMessageId = promptIds[0];
  if (pendingPromptMessageId === undefined || pendingPromptMessageId === "") {
    throw new Error("fixture invariant: turn 14 prompt did not project");
  }

  corruptTwoOpenTurns(filePath);

  const report = await sdk.work.drain({ filePath }, { maxItems: 2 });
  if (!report.ok) throw new Error(`fixture drain failed: ${report.error.reason}`);
  const blockedRun = report.value.ran.find(
    (entry) => entry.kind === "turn_derivation" && entry.disposition === "failed_terminal",
  );
  if (blockedRun === undefined) {
    throw new Error("fixture invariant: turn 13 derivation expected to land terminal on damage");
  }
  if (report.value.remaining !== 1) {
    throw new Error(`fixture invariant: expected exactly one queued item left, got ${report.value.remaining}`);
  }

  return { ...fixture, blockedTurnId: "t13", pendingPromptMessageId };
}

export async function blockedSiblingThread(
  store: TempStore,
): Promise<{ filePath: string; sdk: Lhc; blockedTurnId: string }> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({
    tokenFamily: "o200k",
    inferenceCallbacks: double,
    mode: "manual",
    guards: { detailedTurnCompression: { tinyTurnTokens: 1 } },
  });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  await send(sdk, filePath, turnEvents(1));
  await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "left open before the damage" } })]);
  corruptTwoOpenTurns(filePath);
  const report = await sdk.work.drain({ filePath });
  if (!report.ok) throw new Error(`fixture drain failed: ${report.error.reason}`);
  const blocked = report.value.ran.find(
    (entry) => entry.kind === "turn_derivation" && entry.disposition === "failed_terminal",
  );
  if (blocked === undefined) {
    throw new Error("fixture invariant: turn_derivation expected to land terminal on damage");
  }
  return { filePath, sdk, blockedTurnId: "t1" };
}
