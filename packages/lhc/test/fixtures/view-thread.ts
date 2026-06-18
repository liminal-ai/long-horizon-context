// The Epic 03 derived-thread fixture (Story 0, FC-0.3/0.4/0.5): one recorded
// conversation — 12 turns, 4 chunks, tool-heavy middle — drained through the
// real Epic 02 machinery (intake → enqueue → drain → handlers) against the
// deterministic inference callbacks double into known form states. States are reached
// through production paths, never hand-written rows (the anti-shim line
// FC-0.3 enforces): the failed states come from scripted inference callback failures
// consumed by the real retry/exhaustion mechanics, and blocked comes from
// real source damage on a sacrificial sibling thread. Every later Epic 03
// story compacts against what this builder returns.
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

// Reason classes the scripted failures stamp, chosen from the sweep
// classification table's vocabulary (tech design §Spec Validation): a
// rate-limit class reads transient, a content-refusal class reads permanent —
// FC-0.4's distinguishable-on-read-back guarantee, proven here before
// Story 3 depends on it.
export const TRANSIENT_EXHAUST_REASON = "rate_limit: scripted transient exhaustion (fixture)";
export const PERMANENT_FAILURE_REASON = "content_refusal: scripted permanent failure (fixture)";

// Chunk policy pinned so the 12 fixed-shape turns cut into exactly 4 chunks
// (3 members each; c1–c3 closed, c4 still open). Projections from the
// deterministic double are near-constant in size (`projection(<digest>:<40
// chars>)`), so the cut is stable; the builder asserts the shape and throws
// if drift ever moves it.
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
    // The tool-heavy middle: two tool runs per turn — what gives Story 4 a
    // realistic over-max zone of tool results to age behind the boundary.
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
  turnIds: string[]; // t1..t12
  chunks: ChunkSnapshot;
  // The two manufactured failed subjects (tool_result_summary forms), reached
  // through real retry exhaustion / terminal failure — absent when failures
  // are disabled for a variant.
  failedTransientMessageId?: string;
  failedPermanentMessageId?: string;
  // The straggler variant's turnId-null messages: one between two turns, one
  // after the last turn — absent unless stragglers are enabled.
  stragglerBetweenMessageId?: string;
  stragglerTrailingMessageId?: string;
}

export interface DerivedThreadOptions {
  failures?: boolean; // default true: manufacture the two failed states
  stragglers?: boolean; // default false: insert the turnless runtime notes
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
       SET state = 'failed', content = NULL, reason = ?, metadata = ?, derived_at = ?
       WHERE subject_kind = 'message' AND subject_id = ?
         AND derivation_type = 'tool_result_summary'`,
    ).run(
      reason,
      JSON.stringify({
        attempts: reason === TRANSIENT_EXHAUST_REASON ? 3 : 1,
        lastError: reason,
      }),
      "2026-01-01T00:00:00.000Z",
      subjectId,
    );
  } finally {
    db.close();
  }
}

export async function derivedThreadFixture(
  store: TempStore,
  opts: DerivedThreadOptions = {},
): Promise<DerivedThreadFixture> {
  const failures = opts.failures ?? true;
  const stragglers = opts.stragglers ?? false;

  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({
    inferenceCallbacks: double,
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    chunkPolicy: FIXTURE_CHUNK_POLICY,
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
      // Retryable failures consumed to exhaustion by the head-first drain:
      // the first tool_result_summary item of this batch takes all three
      // attempts and lands failed with the transient reason class.
      double.failKind("tool_result_summary", 3, {
        retryable: true,
        reason: TRANSIENT_EXHAUST_REASON,
      });
    }
    if (failures && turn === 7) {
      // One non-retryable failure: terminal on the first attempt — the
      // permanent reason class, attempts 1.
      double.failKind("tool_result_summary", 1, {
        retryable: false,
        reason: PERMANENT_FAILURE_REASON,
      });
    }
    const messageIds = await send(sdk, filePath, turnEvents(turn));
    // Batch shape is fixed for tool-heavy turns: prompt, thinking, call,
    // result, call, result, text, end — index 3 is the first tool result,
    // the scripted failures' subject.
    const firstToolResultId = messageIds[3];
    if (failures && (turn === 6 || turn === 7)) {
      if (firstToolResultId === undefined || firstToolResultId === "") {
        throw new Error(`fixture invariant: turn ${turn} carries no first tool result message`);
      }
      if (turn === 6) fixture.failedTransientMessageId = firstToolResultId;
      else fixture.failedPermanentMessageId = firstToolResultId;
    }
    await drain(sdk, filePath);

    if (stragglers && turn === 3) {
      // A runtime note between turn 3's end and turn 4's prompt: projected
      // with turnId = null (the Epic 01 straggler), selection rule 6 / G4.
      const noteIds = await send(sdk, filePath, [
        validEvent("runtime_note", {
          payload: { text: "harness restarted between turns (fixture straggler)" },
        }),
      ]);
      const noteId = noteIds[0];
      if (noteId === undefined || noteId === "") {
        throw new Error("fixture invariant: between-turns straggler did not project");
      }
      fixture.stragglerBetweenMessageId = noteId;
    }
    turnIds.push(`t${turn}`);
  }

  if (stragglers) {
    const noteIds = await send(sdk, filePath, [
      validEvent("runtime_note", {
        payload: { text: "session closing note after the last turn (fixture straggler)" },
      }),
    ]);
    const noteId = noteIds[0];
    if (noteId === undefined || noteId === "") {
      throw new Error("fixture invariant: trailing straggler did not project");
    }
    fixture.stragglerTrailingMessageId = noteId;
    await drain(sdk, filePath);
  }

  // Shape invariants the chunk policy is pinned for: 12 closed turns in 4
  // chunks, the first three closed. A failure here means the deterministic
  // substrate moved (inference callback output or tokenizer), not a flaky test.
  fixture.chunks = readChunks(filePath);
  if (fixture.chunks.chunks.length !== 4) {
    throw new Error(
      `fixture invariant: expected 4 chunks, got ${fixture.chunks.chunks.length} — re-pin FIXTURE_CHUNK_POLICY`,
    );
  }
  const closed = fixture.chunks.chunks.filter((chunk) => chunk.status === "closed").length;
  if (closed !== 3) {
    throw new Error(
      `fixture invariant: expected chunks c1–c3 closed, got ${closed} closed — re-pin FIXTURE_CHUNK_POLICY`,
    );
  }

  if (failures) {
    if (fixture.failedTransientMessageId !== undefined) {
      setMessageDerivationFailed(filePath, fixture.failedTransientMessageId, TRANSIENT_EXHAUST_REASON);
    }
    if (fixture.failedPermanentMessageId !== undefined) {
      setMessageDerivationFailed(filePath, fixture.failedPermanentMessageId, PERMANENT_FAILURE_REASON);
    }
    // Verify the manufactured states by read-back through the owning report
    // surface before handing the fixture to any test (FC-0.3's enforcement
    // lives in the tests; this guards the builder's own contract).
    const report = await sdk.messages.report({ filePath });
    if (!report.ok) throw new Error(`fixture report failed: ${report.error.reason}`);
    const transient = failedEntries(report.value, TRANSIENT_EXHAUST_REASON);
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

// The turnless-straggler variant (FC-0.5, golden G4's substrate): the same
// conversation with a runtime note between two turns and one after the last
// turn, fully drained, no manufactured failures.
export async function stragglerVariantThread(store: TempStore): Promise<DerivedThreadFixture> {
  return derivedThreadFixture(store, { failures: false, stragglers: true });
}

// The canonical-corruption variant (FC-0.5, Epic 01 fixture pattern): a
// short real conversation, drained clean, then damaged below the SDK into
// the two-open-turns state no public operation can produce. Canonical
// consumers refuse it with state_corruption.
export async function corruptedVariantThread(store: TempStore): Promise<{ filePath: string; sdk: Lhc }> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  for (let turn = 1; turn <= 3; turn += 1) {
    await send(sdk, filePath, turnEvents(turn));
  }
  await drain(sdk, filePath);
  // Open a turn through real intake, then add a second open row: two open
  // turns, the Epic 01 invariant violation.
  await send(sdk, filePath, [validEvent("user_prompt", { payload: { text: "left open before the damage" } })]);
  corruptTwoOpenTurns(filePath);
  return { filePath, sdk };
}

// ── Epic 04 Story 2 extensions (test plan: fixture extended in place) ──

// The mutation-in-flight variant: the tool-heavy thread compacted, then ONE
// edit applied through the production mutation path with the drain NOT
// settled — so the cascade's cleared-pending states and their queued work
// are real production states, never hand-written rows (FC-fidelity rule).
// Serves the mid-rebuild overview shape (TC-1.1) and the rebuild bracket's
// opening state (TC-4.3).
export interface MutationInFlightFixture extends DerivedThreadFixture {
  compactReceipt: CompactReceipt;
  editedMessageId: string;
  // The cascade contract's exact account of the edit: cleared set, queued
  // replacements, superseded items — what the bracketing health reads
  // assert against.
  mutation: MutationResult;
}

export async function mutationInFlightVariant(store: TempStore): Promise<MutationInFlightFixture> {
  // No manufactured failures: the bracket's "nothing outside the cascade
  // changed state" assertion wants a clean baseline.
  const fixture = await derivedThreadFixture(store, { failures: false });
  const { sdk, filePath } = fixture;

  const compacted = await sdk.threadView.compact({ filePath }, {});
  if (!compacted.ok) {
    throw new Error(`fixture compact failed: ${compacted.error.reason}`);
  }

  // A mid-thread closed-turn target: turn 2's prompt, so the cascade spans
  // all three subject kinds — its own smoothed_prompt, t2's two turn forms,
  // and c1's two chunk summaries.
  const listed = await sdk.messages.listMessages({ filePath });
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

// The mixed-state variant (TC-4.1's substrate): one thread carrying every
// operational state at once — ready (the drained body), failed-transient and
// failed-permanent (the scripted exhaustions), blocked (a turn derivation
// meeting real source damage), and pending with live queued work (a partial
// drain stopping short). All states reached through intake, mutation, and
// drain behavior; the only below-SDK write is the sanctioned two-open-turns
// corruption.
export interface MixedStateFixture extends DerivedThreadFixture {
  blockedTurnId: string; // t13: turn forms blocked through the terminal path
  pendingPromptMessageId: string; // t14's prompt: smoothed_prompt still queued
}

export async function mixedStateVariantThread(store: TempStore): Promise<MixedStateFixture> {
  const fixture = await derivedThreadFixture(store);
  const { sdk, filePath } = fixture;

  // Turn 13 closes cleanly but is NOT drained: its prompt smoothing and turn
  // derivation sit queued (events: prompt, thinking, text, end — no tools).
  await send(sdk, filePath, turnEvents(13));

  // Turn 14 opens with a lone prompt: one more queued smoothing item that the
  // partial drain below will leave pending.
  const promptIds = await send(sdk, filePath, [
    validEvent("user_prompt", {
      payload: { text: "turn 14: this prompt's smoothing stays pending" },
    }),
  ]);
  const pendingPromptMessageId = promptIds[0];
  if (pendingPromptMessageId === undefined || pendingPromptMessageId === "") {
    throw new Error("fixture invariant: turn 14 prompt did not project");
  }

  // Real source damage: t14 is open, the corruption writer adds a second open
  // row — the state t13's claimed derivation meets at drain time.
  corruptTwoOpenTurns(filePath);

  // Partial drain, head-first FIFO: item 1 is t13's prompt smoothing (ready),
  // item 2 is t13's turn derivation (terminal on the damage → blocked).
  // t14's smoothing stays queued — the live pending state.
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

// The blocked state's sacrificial sibling (FC-0.3): a closed turn whose
// queued derivation meets real source damage at drain time — the handler
// finds two open turns and lands the turn forms blocked through the
// production terminal path, never a hand-written row.
export async function blockedSiblingThread(
  store: TempStore,
): Promise<{ filePath: string; sdk: Lhc; blockedTurnId: string }> {
  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({ inferenceCallbacks: double, mode: "manual" });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  // Turn 1 closes (its turn_derivation queues); a second turn opens through
  // real intake; the corruption writer adds another open row. The drain then
  // claims t1's derivation against a record with two open turns.
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
