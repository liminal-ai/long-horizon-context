import { DatabaseSync } from "node:sqlite";
import {
  type DependencyGap,
  type Derivation,
  type DerivationMetadata,
  type DerivationState,
  type Lhc,
  type MessageEventInput,
  type SubjectKind,
  threads,
} from "../../src/index.js";
import { corruptTwoOpenTurns } from "./corrupt.js";
import { type TempStore, validEvent } from "./index.js";
import type { InferenceCallbacksDouble } from "./inference-callbacks-double.js";
import type { DerivationType } from "./model-call.js";
import { sendMessageEvents } from "./tokens.js";

async function newThreadFile(store: TempStore): Promise<string> {
  const filePath = store.threadPath();
  const created = await threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(`fixture thread creation failed: ${created.error.reason}`);
  return filePath;
}

async function send(filePath: string, batch: readonly MessageEventInput[]): Promise<void> {
  const result = await sendMessageEvents({ filePath }, batch);
  if (!result.ok) throw new Error(`fixture batch failed: ${result.error.reason}`);
}

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

interface RawFormRow {
  subject_kind: string;
  subject_id: string;
  derivation_type: string;
  state: string;
  content: string | null;
  reason: string | null;
  metadata: string | null;
  source_version: number | bigint;
  gaps: string | null;
  derived_at: string | null;
}

export function readDerivedForms(filePath: string): Derivation[] {
  const db = new DatabaseSync(filePath);
  try {
    const rows = db
      .prepare(
        `SELECT subject_kind, subject_id, derivation_type, state, content, reason, metadata,
                source_version, gaps, derived_at
         FROM derivation ORDER BY subject_kind, subject_id, derivation_type`,
      )
      .all() as unknown as RawFormRow[];
    return rows.map((row) => {
      const record: Derivation = {
        subjectKind: row.subject_kind as SubjectKind,
        subjectId: row.subject_id,
        derivationType: row.derivation_type as DerivationType,
        state: row.state as DerivationState,
        sourceVersion: Number(row.source_version),
      };
      if (row.content !== null) record.content = row.content;
      if (row.reason !== null) record.reason = row.reason;
      if (row.metadata !== null) {
        record.metadata = JSON.parse(row.metadata) as DerivationMetadata;
      }
      if (row.gaps !== null) record.gaps = JSON.parse(row.gaps) as DependencyGap[];
      if (row.derived_at !== null) record.derivedAt = row.derived_at;
      return record;
    });
  } finally {
    db.close();
  }
}

export function setFormState(
  filePath: string,
  target: { subjectKind: SubjectKind; subjectId: string; derivationType: DerivationType },
  update: {
    state: DerivationState;
    content?: string;
    reason?: string;
    metadata?: DerivationMetadata;
    derivedAt?: string;
  },
): void {
  const db = new DatabaseSync(filePath);
  try {
    const changed = db
      .prepare(
        `UPDATE derivation
         SET state = ?, content = ?, reason = ?, metadata = ?, derived_at = ?
         WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?`,
      )
      .run(
        update.state,
        update.content ?? null,
        update.reason ?? null,
        update.metadata === undefined ? null : JSON.stringify(update.metadata),
        update.derivedAt ?? null,
        target.subjectKind,
        target.subjectId,
        target.derivationType,
      );
    if (Number(changed.changes) !== 1) {
      throw new Error(
        `fixture setFormState hit ${String(changed.changes)} rows for ${target.subjectKind}/${target.subjectId}/${target.derivationType}; expected the pending row from enqueue`,
      );
    }
  } finally {
    db.close();
  }
}

export interface MultiStateClaim {
  subjectKind: SubjectKind;
  subjectId: string;
  derivationType: DerivationType;
  state: DerivationState;
}

export async function multiStateThread(store: TempStore): Promise<{ filePath: string; expected: MultiStateClaim[] }> {
  const filePath = await newThreadFile(store);
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
    { subjectKind: "message", subjectId: "m1", derivationType: "smoothed_prompt" },
    { state: "ready", content: "smoothed(fixture:first prompt)", derivedAt },
  );
  setFormState(
    filePath,
    { subjectKind: "message", subjectId: "m4", derivationType: "tool_result_summary" },
    {
      state: "ready",
      content: "toolresult(fixture:contents of a.txt)",
      metadata: { outcome: "succeeded" },
      derivedAt,
    },
  );
  setFormState(
    filePath,
    { subjectKind: "turn", subjectId: "t1", derivationType: "turn_rendering" },
    { state: "failed", reason: "provider_failure: scripted failure (fixture)" },
  );
  setFormState(
    filePath,
    { subjectKind: "turn", subjectId: "t2", derivationType: "turn_rendering" },
    { state: "blocked", reason: "source_damaged: manufactured damage (fixture)" },
  );
  return {
    filePath,
    expected: [
      { subjectKind: "message", subjectId: "m1", derivationType: "smoothed_prompt", state: "ready" },
      { subjectKind: "message", subjectId: "m4", derivationType: "tool_result_summary", state: "ready" },
      { subjectKind: "message", subjectId: "m6", derivationType: "smoothed_prompt", state: "pending" },
      { subjectKind: "turn", subjectId: "t1", derivationType: "turn_rendering", state: "failed" },
      { subjectKind: "turn", subjectId: "t1", derivationType: "pre_detailed_assembly", state: "pending" },
      { subjectKind: "turn", subjectId: "t2", derivationType: "turn_rendering", state: "blocked" },
      { subjectKind: "turn", subjectId: "t2", derivationType: "pre_detailed_assembly", state: "pending" },
    ],
  };
}

export async function damagedSourceThread(store: TempStore): Promise<{ filePath: string; turnId: string }> {
  const { filePath, turnIds } = await threadWithClosedTurns(store, 1);
  await send(filePath, [validEvent("user_prompt", { payload: { text: "left open" } })]);
  corruptTwoOpenTurns(filePath);
  const turnId = turnIds[0];
  if (turnId === undefined) throw new Error("fixture invariant: one closed turn expected");
  return { filePath, turnId };
}

export const GAPPED_SMOOTHING_REASON = "provider_failure: scripted smoothing failure";

export async function gappedRenderingThread(
  store: TempStore,
  sdk: Lhc,
  double: InferenceCallbacksDouble,
): Promise<{ filePath: string; messageId: string; turnId: string }> {
  const filePath = await newThreadFile(store);
  double.failKind("prompt_smoothing", 1, {
    reason: GAPPED_SMOOTHING_REASON,
  });
  await send(filePath, [
    validEvent("user_prompt", { payload: { text: "gapped prompt" } }),
    validEvent("assistant_text", { payload: { text: "gapped answer" } }),
    validEvent("turn_end"),
  ]);
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(`fixture drain failed: ${drained.error.reason}`);
  setFormState(
    filePath,
    { subjectKind: "message", subjectId: "m1", derivationType: "smoothed_prompt" },
    { state: "failed", reason: GAPPED_SMOOTHING_REASON },
  );
  const forms = readDerivedForms(filePath);
  const smoothing = forms.find((f) => f.subjectId === "m1" && f.derivationType === "smoothed_prompt");
  const rendering = forms.find((f) => f.subjectId === "t1" && f.derivationType === "turn_rendering");
  if (smoothing?.state !== "failed" || rendering?.state !== "ready" || rendering.gaps !== undefined) {
    throw new Error("fixture invariant: failed smoothing under a ready fallback rendering expected");
  }
  return { filePath, messageId: "m1", turnId: "t1" };
}
