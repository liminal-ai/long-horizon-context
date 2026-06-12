// Thread builders for Epic 02 (test plan §Test Substrate). All built through
// real intake; the multi-state and damaged-source builders then apply the
// sanctioned below-SDK writes for states the SDK cannot yet produce (drain
// and handlers land in Stories 1–3) — Story 0 proves read-back of what the
// builders wrote; Stories 2/4 confirm the states arise for real
// (coverage.md cross-story debt).
import { DatabaseSync } from "node:sqlite";
import {
  intakeStream,
  threads,
  type DerivedForm,
  type DerivedFormState,
  type DependencyGap,
  type FormKind,
  type Lhc,
  type MessageEventInput,
  type SubjectKind,
  type ToolOutcome,
} from "../../src/index.js";
import { setIntakeClock } from "./intake-seam.js";
import { corruptTwoOpenTurns } from "./corrupt.js";
import type { ProviderDouble } from "./provider-double.js";
import { validEvent, type TempStore } from "./index.js";

async function newThreadFile(store: TempStore): Promise<string> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

async function send(filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await intakeStream.messageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
}

// n closed turns, each prompt + assistant text + explicit end. Turn ids are
// deterministic (t1..tn) per the turn store's id scheme.
export async function threadWithClosedTurns(
  store: TempStore,
  n: number,
): Promise<{ filePath: string; turnIds: string[] }> {
  const filePath = await newThreadFile(store);
  const turnIds: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    await send(filePath, [
      validEvent("user_prompt", { payload: { text: `prompt for turn ${i}` } }),
      validEvent("assistant_text", { payload: { text: `answer for turn ${i}` } }),
      validEvent("turn_end"),
    ]);
    turnIds.push(`t${i}`);
  }
  return { filePath, turnIds };
}

// One closed turn containing a tool run: call + result pair by default;
// error and missing-result variants per the epic's outcome vocabulary.
export async function threadWithToolRun(
  store: TempStore,
  opts: { isError?: boolean; missingResult?: boolean; resultContent?: string } = {},
): Promise<{ filePath: string; turnId: string }> {
  const filePath = await newThreadFile(store);
  const batch: MessageEventInput[] = [
    validEvent("user_prompt", { payload: { text: "please run the tool" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-fixture-1", toolName: "read_file", arguments: { path: "notes.txt" } },
    }),
  ];
  if (opts.missingResult !== true) {
    batch.push(
      validEvent("tool_result", {
        payload: {
          toolCallId: "call-fixture-1",
          content: opts.resultContent ?? "contents of notes.txt",
          isError: opts.isError ?? false,
        },
      }),
    );
  }
  batch.push(validEvent("turn_end"));
  await send(filePath, batch);
  return { filePath, turnId: "t1" };
}

// ── chunk read-back (Story 3): raw rows for boundary assertions ──

export interface ChunkSnapshot {
  chunks: Array<{
    chunkId: string;
    chunkOrder: number;
    status: "open" | "closed";
    accumulatedProjectedTokens: number;
  }>;
  members: Array<{ chunkId: string; turnId: string; memberIdx: number }>;
}

export function readChunks(filePath: string): ChunkSnapshot {
  const db = new DatabaseSync(filePath);
  try {
    const chunks = (
      db
        .prepare(
          `SELECT chunk_id, chunk_order, status, accumulated_projected_tokens
           FROM chunk ORDER BY chunk_order`,
        )
        .all() as unknown as Array<{
        chunk_id: string;
        chunk_order: number | bigint;
        status: string;
        accumulated_projected_tokens: number | bigint;
      }>
    ).map((row) => ({
      chunkId: row.chunk_id,
      chunkOrder: Number(row.chunk_order),
      status: row.status as "open" | "closed",
      accumulatedProjectedTokens: Number(row.accumulated_projected_tokens),
    }));
    const members = (
      db
        .prepare(
          `SELECT cm.chunk_id, cm.turn_id, cm.member_idx FROM chunk_member cm
           JOIN chunk c ON c.chunk_id = cm.chunk_id
           ORDER BY c.chunk_order, cm.member_idx`,
        )
        .all() as unknown as Array<{
        chunk_id: string;
        turn_id: string;
        member_idx: number | bigint;
      }>
    ).map((row) => ({
      chunkId: row.chunk_id,
      turnId: row.turn_id,
      memberIdx: Number(row.member_idx),
    }));
    return { chunks, members };
  } finally {
    db.close();
  }
}

// ── derived_form read-back and the sanctioned state writer ───────

interface RawFormRow {
  subject_kind: string;
  subject_id: string;
  form: string;
  state: string;
  content: string | null;
  reason: string | null;
  metadata: string | null;
  source_version: number | bigint;
  gaps: string | null;
  derived_at: string | null;
}

export function readDerivedForms(filePath: string): DerivedForm[] {
  const db = new DatabaseSync(filePath);
  try {
    const rows = db
      .prepare(
        `SELECT subject_kind, subject_id, form, state, content, reason, metadata,
                source_version, gaps, derived_at
         FROM derived_form ORDER BY subject_kind, subject_id, form`,
      )
      .all() as unknown as RawFormRow[];
    return rows.map((row) => {
      const record: DerivedForm = {
        subjectKind: row.subject_kind as SubjectKind,
        subjectId: row.subject_id,
        form: row.form as FormKind,
        state: row.state as DerivedFormState,
        sourceVersion: Number(row.source_version),
      };
      if (row.content !== null) record.content = row.content;
      if (row.reason !== null) record.reason = row.reason;
      if (row.metadata !== null) {
        record.metadata = JSON.parse(row.metadata) as { outcome?: ToolOutcome };
      }
      if (row.gaps !== null) record.gaps = JSON.parse(row.gaps) as DependencyGap[];
      if (row.derived_at !== null) record.derivedAt = row.derived_at;
      return record;
    });
  } finally {
    db.close();
  }
}

// Below-SDK state writer, sanctioned like corrupt.ts: ready/failed/blocked
// are unreachable through the SDK until the drain (Story 1) and handlers
// (Stories 2–3) land. UPDATE-only on purpose — the pending row exists from
// enqueue, mirroring the production completion contract.
export function setFormState(
  filePath: string,
  target: { subjectKind: SubjectKind; subjectId: string; form: FormKind },
  update: {
    state: DerivedFormState;
    content?: string;
    reason?: string;
    metadata?: { outcome?: ToolOutcome };
    derivedAt?: string;
  },
): void {
  const db = new DatabaseSync(filePath);
  try {
    const changed = db
      .prepare(
        `UPDATE derived_form
         SET state = ?, content = ?, reason = ?, metadata = ?, derived_at = ?
         WHERE subject_kind = ? AND subject_id = ? AND form = ?`,
      )
      .run(
        update.state,
        update.content ?? null,
        update.reason ?? null,
        update.metadata === undefined ? null : JSON.stringify(update.metadata),
        update.derivedAt ?? null,
        target.subjectKind,
        target.subjectId,
        target.form,
      );
    if (Number(changed.changes) !== 1) {
      throw new Error(
        `fixture setFormState hit ${String(changed.changes)} rows for ${target.subjectKind}/${target.subjectId}/${target.form}; expected the pending row from enqueue`,
      );
    }
  } finally {
    db.close();
  }
}

// ── multi-state thread: every form state in one file ─────────────

export interface MultiStateClaim {
  subjectKind: SubjectKind;
  subjectId: string;
  form: FormKind;
  state: DerivedFormState;
}

export async function multiStateThread(
  store: TempStore,
): Promise<{ filePath: string; expected: MultiStateClaim[] }> {
  const filePath = await newThreadFile(store);
  // Turn 1: prompt + tool run; turn 2: prompt. Intake's enqueue leaves every
  // form pending; the writes below move a subset into the other three states.
  await send(filePath, [
    validEvent("user_prompt", { payload: { text: "first prompt" } }),
    validEvent("assistant_text", { payload: { text: "working on it" } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-ms-1", toolName: "read_file", arguments: { path: "a.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-ms-1", content: "contents of a.txt", isError: false },
    }),
    validEvent("turn_end"),
    validEvent("user_prompt", { payload: { text: "second prompt" } }),
    validEvent("turn_end"),
  ]);
  const derivedAt = "2026-06-10T12:00:00.000Z";
  setFormState(
    filePath,
    { subjectKind: "message", subjectId: "m1", form: "smoothed_prompt" },
    { state: "ready", content: "smoothed(fixture:first prompt)", derivedAt },
  );
  // Tool-activity outcome lives in machine-readable metadata, never inside
  // provider-authored content (FC-0.3).
  setFormState(
    filePath,
    { subjectKind: "message", subjectId: "m4", form: "tool_result_summary" },
    {
      state: "ready",
      content: "toolresult(fixture:contents of a.txt)",
      metadata: { outcome: "succeeded" },
      derivedAt,
    },
  );
  setFormState(
    filePath,
    { subjectKind: "turn", subjectId: "t1", form: "turn_rendering" },
    { state: "failed", reason: "provider_failure: scripted exhaustion (fixture)" },
  );
  setFormState(
    filePath,
    { subjectKind: "turn", subjectId: "t2", form: "turn_rendering" },
    { state: "blocked", reason: "source_damaged: manufactured damage (fixture)" },
  );
  return {
    filePath,
    expected: [
      { subjectKind: "message", subjectId: "m1", form: "smoothed_prompt", state: "ready" },
      { subjectKind: "message", subjectId: "m4", form: "tool_result_summary", state: "ready" },
      { subjectKind: "message", subjectId: "m6", form: "smoothed_prompt", state: "pending" },
      { subjectKind: "turn", subjectId: "t1", form: "turn_rendering", state: "failed" },
      { subjectKind: "turn", subjectId: "t1", form: "lower_band_projection", state: "pending" },
      { subjectKind: "turn", subjectId: "t2", form: "turn_rendering", state: "blocked" },
      { subjectKind: "turn", subjectId: "t2", form: "lower_band_projection", state: "pending" },
    ],
  };
}

// ── damaged-source thread (Epic 01 corruption definition) ────────

// A closed turn with its turn_derivation work queued, then the Epic 01
// two-open-turns corruption — the damage a turn handler must find and the
// intake pipeline refuses (turn_state_corrupt).
export async function damagedSourceThread(
  store: TempStore,
): Promise<{ filePath: string; turnId: string }> {
  const { filePath, turnIds } = await threadWithClosedTurns(store, 1);
  // Open a second turn through real intake; the corruption writer then adds
  // another open row — two open turns, the Epic 01 invariant violation.
  await send(filePath, [validEvent("user_prompt", { payload: { text: "left open" } })]);
  corruptTwoOpenTurns(filePath);
  const turnId = turnIds[0];
  if (turnId === undefined) throw new Error("fixture invariant: one closed turn expected");
  return { filePath, turnId };
}

// ── gapped-rendering thread (TC-3.2's state, shared) ─────────────

// TC-3.2's gapped-rendering state as one shared builder (coverage.md
// cross-story debt: TC-4.4 consumes this exact scenario; don't rebuild it by
// hand). Expects a manual-mode SDK with retry budget 3 and zero backoff:
// scripts the double to exhaust the prompt's smoothing, then drains — the
// smoothing lands failed (its work row deleted at exhaustion, DD-1) and the
// turn rendering lands ready with the recorded gap.
export const GAPPED_SMOOTHING_REASON = "provider_failure: scripted smoothing exhaustion";

export async function gappedRenderingThread(
  store: TempStore,
  sdk: Lhc,
  double: ProviderDouble,
): Promise<{ filePath: string; messageId: string; turnId: string }> {
  const filePath = await newThreadFile(store);
  double.failKind("prompt_smoothing", 3, {
    retryable: true,
    reason: GAPPED_SMOOTHING_REASON,
  });
  await send(filePath, [
    validEvent("user_prompt", { payload: { text: "gapped prompt" } }),
    validEvent("assistant_text", { payload: { text: "gapped answer" } }),
    validEvent("turn_end"),
  ]);
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(`fixture drain failed: ${drained.error.reason}`);
  const forms = readDerivedForms(filePath);
  const smoothing = forms.find((f) => f.subjectId === "m1" && f.form === "smoothed_prompt");
  const rendering = forms.find((f) => f.subjectId === "t1" && f.form === "turn_rendering");
  if (
    smoothing?.state !== "failed" ||
    rendering?.state !== "ready" ||
    rendering.gaps === undefined
  ) {
    throw new Error(
      "fixture invariant: failed smoothing under a ready, gapped rendering expected",
    );
  }
  return { filePath, messageId: "m1", turnId: "t1" };
}
