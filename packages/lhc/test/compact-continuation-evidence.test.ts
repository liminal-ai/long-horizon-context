/**
 * LIM-61 evidence tests: real runtime cases required for Fable certification.
 * Each test name states exactly what is exercised — no admitted skips.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPendingBoundary, upsertBoundary } from "../src/compact-continuation/internal/store.js";
import {
  type CompactContinuationHostFacts,
  compactContinuation,
  compactContinuationMarkerIdempotencyKey,
  initLhc,
  intakeStream,
  messages,
  provePendingToolPair,
  threads,
  validateHostFacts,
} from "../src/index.js";
import { CURRENT_THREAD_SCHEMA_VERSION } from "../src/shared-tech/storage.js";
import {
  type CompactContinuationTestHooks,
  createInferenceCallbacksDouble,
  derivedThreadFixture,
  openRaw,
  runCompactContinuationForTests,
  setViewInjectionHook,
  type TempStore,
  tempStore,
  validEvent,
} from "./fixtures/index.js";

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
  setViewInjectionHook("compact-install-before-validate", null);
});

const SETTLED_SEAM = {
  modelResponseComplete: true,
  requestedToolsSettled: true,
  captureFlushed: true,
  beforeNextProviderRequest: true,
  insideTransportRetry: false,
  inputEpochAtDecision: 1,
  inputEpochAtApply: 1,
} as const;

function baseFacts(overrides: Partial<CompactContinuationHostFacts> = {}): CompactContinuationHostFacts {
  return {
    attemptId: overrides.attemptId ?? "attempt-1",
    seam: overrides.seam ?? { ...SETTLED_SEAM },
    providerUsage: overrides.providerUsage ?? {
      available: true,
      inputTokens: 90000,
      cacheCreationTokens: 5000,
      cacheReadTokens: 10000,
      total: 105000,
      domain: "provider_reported_input",
    },
    postMeasurementEstimate: overrides.postMeasurementEstimate ?? {
      tokens: 2000,
      source: "lhc_token_estimate",
      domain: "source_labelled_estimate",
    },
    policy: overrides.policy ?? {
      upperTriggerTokens: 100000,
      lowerTargetTokens: 400,
      hostCapability: "full_state_machine",
      safeRunwayThresholdTokens: 200000,
      safeRunwayThresholdSource: "host_safe_runway",
    },
    continuation: overrides.continuation ?? { kind: "active_non_tool" },
    writerClaim: overrides.writerClaim ?? "none",
    captureComplete: overrides.captureComplete ?? true,
    providerIdentityValid: overrides.providerIdentityValid ?? true,
    actor: overrides.actor ?? "fixture-actor",
    harness: overrides.harness ?? "fixture-harness",
    compact: overrides.compact ?? {
      params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } },
    },
    ...(overrides.singleOpenTurn !== undefined ? { singleOpenTurn: overrides.singleOpenTurn } : {}),
  };
}

async function runCCTest(filePath: string, facts: CompactContinuationHostFacts, hooks?: CompactContinuationTestHooks) {
  return runCompactContinuationForTests({ filePath }, facts, () => new Date(), hooks);
}

function writerClaimOf(filePath: string): { claim: string; attemptId: string | null } {
  const db = openRaw(filePath);
  try {
    const row = db.prepare(`SELECT claim, attempt_id FROM compact_continuation_writer WHERE singleton = 1`).get() as {
      claim: string;
      attempt_id: string | null;
    };
    return { claim: row.claim, attemptId: row.attempt_id };
  } finally {
    db.close();
  }
}

function snapshotCanonical(filePath: string): {
  eventCount: number;
  turnCount: number;
  markerCount: number;
  viewId: string | null;
  maxEventOrder: number;
} {
  const db = openRaw(filePath);
  try {
    const eventCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM event`).get() as { n: number | bigint }).n);
    const turnCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number | bigint }).n);
    const markerCount = Number(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM event WHERE event_kind = 'compact_continuation_marker'`).get() as {
          n: number | bigint;
        }
      ).n,
    );
    const view = db.prepare(`SELECT view_id FROM thread_view WHERE singleton = 1`).get() as
      | { view_id: string }
      | undefined;
    const maxEventOrder = Number(
      (db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as { m: number | bigint }).m,
    );
    return {
      eventCount,
      turnCount,
      markerCount,
      viewId: view?.view_id ?? null,
      maxEventOrder,
    };
  } finally {
    db.close();
  }
}

async function seedPendingToolTurn(filePath: string, toolCallId: string): Promise<void> {
  const batch = await intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "use tools" } }),
    validEvent("assistant_text", { payload: { text: "calling tool" } }),
    validEvent("tool_call", {
      payload: { toolCallId, toolName: "read_file", arguments: { path: "notes.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId, content: "tool result verbatim payload that must survive", isError: false },
    }),
  ]);
  if (!batch.ok) throw new Error(batch.error.reason);
}

async function seedOpenAgenticTurn(filePath: string): Promise<void> {
  const batch = await intakeStream.messageEvents({ filePath }, [
    validEvent("user_prompt", { payload: { text: "continue the investigation with more context" } }),
    validEvent("assistant_text", { payload: { text: "working on it with more detail ".repeat(20) } }),
    validEvent("tool_call", {
      payload: { toolCallId: "call-active-1", toolName: "read_file", arguments: { path: "x.txt" } },
    }),
    validEvent("tool_result", {
      payload: { toolCallId: "call-active-1", content: "result body ".repeat(30), isError: false },
    }),
  ]);
  if (!batch.ok) throw new Error(batch.error.reason);
}

function nextEventOrder(db: ReturnType<typeof openRaw>): number {
  return (
    Number((db.prepare(`SELECT COALESCE(MAX(event_order), 0) AS m FROM event`).get() as { m: number | bigint }).m) + 1
  );
}

function insertDupMessage(
  db: ReturnType<typeof openRaw>,
  src: {
    kind: string;
    turn_id: string;
    token_estimate: number | bigint;
    actor: string;
    harness: string;
    content: string;
    block_type: string;
  },
  dupId: string,
): void {
  const order = nextEventOrder(db);
  db.prepare(
    `INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(order, src.kind, `dup-key-${dupId}`, src.actor, src.harness, src.content, new Date().toISOString());
  db.prepare(
    `INSERT INTO message (message_id, kind, source_event_order, turn_id, token_estimate, actor, harness, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(dupId, src.kind, order, src.turn_id, Number(src.token_estimate), src.actor, src.harness);
  db.prepare(`INSERT INTO message_block (message_id, block_index, block_type, content) VALUES (?, 0, ?, ?)`).run(
    dupId,
    src.block_type,
    src.content,
  );
}

/** Label: shapes that normal intake cannot produce require corrupt-state fixtures. */
type FixtureKind = "normal_pipeline" | "corrupt_state_fixture";

describe("LIM-61 evidence: tool-pair runtime matrix (public runCompactContinuation)", () => {
  async function assertDeclinesWithoutMutation(
    name: string,
    toolCallId: string,
    kind: FixtureKind,
    mutate: (filePath: string) => void | Promise<void>,
    opts: { seedToolCallId?: string } = {},
  ): Promise<void> {
    const fixture = await derivedThreadFixture(store, { failures: false });
    // Seed a real pair unless this is a pure missing-id case.
    const seedId = opts.seedToolCallId ?? toolCallId;
    if (seedId !== "") {
      await seedPendingToolTurn(fixture.filePath, seedId);
    } else {
      await seedPendingToolTurn(fixture.filePath, "call-unrelated-other");
    }
    await mutate(fixture.filePath);
    const before = snapshotCanonical(fixture.filePath);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });

    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: `pair-${name}`,
        continuation: {
          kind: "pending_correlated_tool_result",
          protectedToolCallIds: [toolCallId],
          correlationValid: true,
        },
      }),
    );
    expect(result.ok, `${name} (${kind})`).toBe(true);
    if (!result.ok) return;
    // The pair cannot be *protected* through compact, so the continuation
    // machinery declines into the host's ordinary settled-seam compact on
    // canonical state. It still mutates nothing and never claims the writer —
    // and it never strands: the next provider request proceeds.
    expect(result.value.receipt.outcome).toBe("decline_to_ordinary_compact");
    expect(result.value.receipt.refused).toBe(false);
    expect(result.value.receipt.refuseCode).toBeNull();
    expect(result.value.receipt.warnings.map((w) => w.code)).toEqual(["tool_correlation_unproven"]);
    expect(result.value.receipt.residual.nextProviderRequestAllowed).toBe(true);
    expect(result.value.receipt.effects.some((e) => e.type === "claim_writer")).toBe(false);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
    expect(snapshotCanonical(fixture.filePath)).toEqual(before);
  }

  it("missing pair: declines into ordinary compact before claim, no mutation", async () => {
    // Seed an unrelated pair; request a toolCallId that does not exist.
    await assertDeclinesWithoutMutation("missing", "does-not-exist", "normal_pipeline", () => {}, {
      seedToolCallId: "call-unrelated-other",
    });
  });

  it("orphan call: tombstone result via SQL (corrupt_state_fixture) — declines into ordinary compact, no mutation", async () => {
    await assertDeclinesWithoutMutation("orphan-call", "call-oc", "corrupt_state_fixture", (filePath) => {
      const db = openRaw(filePath);
      try {
        db.prepare(
          `UPDATE message SET deleted_at = ? WHERE message_id IN (
             SELECT m.message_id FROM message m
             JOIN message_block b ON b.message_id = m.message_id
             WHERE b.block_type = 'tool_result' AND json_extract(b.content, '$.toolCallId') = 'call-oc'
           )`,
        ).run(new Date().toISOString());
      } finally {
        db.close();
      }
    });
  });

  it("orphan result: tombstone call via SQL (corrupt_state_fixture) — declines into ordinary compact, no mutation", async () => {
    await assertDeclinesWithoutMutation("orphan-result", "call-or", "corrupt_state_fixture", (filePath) => {
      const db = openRaw(filePath);
      try {
        db.prepare(
          `UPDATE message SET deleted_at = ? WHERE message_id IN (
             SELECT m.message_id FROM message m
             JOIN message_block b ON b.message_id = m.message_id
             WHERE b.block_type = 'tool_call' AND json_extract(b.content, '$.toolCallId') = 'call-or'
           )`,
        ).run(new Date().toISOString());
      } finally {
        db.close();
      }
    });
  });

  it("duplicate call: second tool_call row (corrupt_state_fixture) — declines into ordinary compact, no mutation", async () => {
    await assertDeclinesWithoutMutation("duplicate-call", "call-dc", "corrupt_state_fixture", (filePath) => {
      const db = openRaw(filePath);
      try {
        const call = db
          .prepare(
            `SELECT m.message_id, m.kind, m.turn_id, m.token_estimate, m.actor, m.harness, b.content
             FROM message m
             JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_call'
             WHERE json_extract(b.content, '$.toolCallId') = 'call-dc' AND m.deleted_at IS NULL`,
          )
          .get() as {
          message_id: string;
          kind: string;
          turn_id: string;
          token_estimate: number | bigint;
          actor: string;
          harness: string;
          content: string;
        };
        insertDupMessage(
          db,
          {
            kind: call.kind,
            turn_id: call.turn_id,
            token_estimate: call.token_estimate,
            actor: call.actor,
            harness: call.harness,
            content: call.content,
            block_type: "tool_call",
          },
          `${call.message_id}-dup`,
        );
      } finally {
        db.close();
      }
    });
  });

  it("duplicate result: second tool_result row (corrupt_state_fixture) — declines into ordinary compact, no mutation", async () => {
    await assertDeclinesWithoutMutation("duplicate-result", "call-dr", "corrupt_state_fixture", (filePath) => {
      const db = openRaw(filePath);
      try {
        const row = db
          .prepare(
            `SELECT m.message_id, m.kind, m.turn_id, m.token_estimate, m.actor, m.harness, b.content
             FROM message m
             JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_result'
             WHERE json_extract(b.content, '$.toolCallId') = 'call-dr' AND m.deleted_at IS NULL`,
          )
          .get() as {
          message_id: string;
          kind: string;
          turn_id: string;
          token_estimate: number | bigint;
          actor: string;
          harness: string;
          content: string;
        };
        insertDupMessage(
          db,
          {
            kind: row.kind,
            turn_id: row.turn_id,
            token_estimate: row.token_estimate,
            actor: row.actor,
            harness: row.harness,
            content: row.content,
            block_type: "tool_result",
          },
          `${row.message_id}-dup`,
        );
      } finally {
        db.close();
      }
    });
  });

  it("call after result: swap source_event_order (corrupt_state_fixture) — declines into ordinary compact, no mutation", async () => {
    await assertDeclinesWithoutMutation("call-after-result", "call-car", "corrupt_state_fixture", (filePath) => {
      const db = openRaw(filePath);
      try {
        const call = db
          .prepare(
            `SELECT m.message_id, m.source_event_order FROM message m
             JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_call'
             WHERE json_extract(b.content, '$.toolCallId') = 'call-car'`,
          )
          .get() as { message_id: string; source_event_order: number | bigint };
        const result = db
          .prepare(
            `SELECT m.message_id, m.source_event_order FROM message m
             JOIN message_block b ON b.message_id = m.message_id AND b.block_type = 'tool_result'
             WHERE json_extract(b.content, '$.toolCallId') = 'call-car'`,
          )
          .get() as { message_id: string; source_event_order: number | bigint };
        const co = Number(call.source_event_order);
        const ro = Number(result.source_event_order);
        const tmp = nextEventOrder(db);
        db.prepare(
          `INSERT INTO event (event_order, event_kind, idempotency_key, actor, harness, payload, recorded_at)
           VALUES (?, 'runtime_note', ?, 'fixture', 'fixture', '{}', ?)`,
        ).run(tmp, `tmp-swap-${tmp}`, new Date().toISOString());
        db.prepare(`UPDATE message SET source_event_order = ? WHERE message_id = ?`).run(tmp, call.message_id);
        db.prepare(`UPDATE message SET source_event_order = ? WHERE message_id = ?`).run(co, result.message_id);
        db.prepare(`UPDATE message SET source_event_order = ? WHERE message_id = ?`).run(ro, call.message_id);
        db.prepare(`DELETE FROM event WHERE event_order = ?`).run(tmp);
      } finally {
        db.close();
      }
    });
  });

  it("wrong turn: move call to closed turn (corrupt_state_fixture) — declines into ordinary compact, no mutation", async () => {
    await assertDeclinesWithoutMutation("wrong-turn", "call-wt", "corrupt_state_fixture", (filePath) => {
      const db = openRaw(filePath);
      try {
        const other = db
          .prepare(`SELECT turn_id FROM turns WHERE status != 'open' ORDER BY turn_order LIMIT 1`)
          .get() as { turn_id: string } | undefined;
        if (other === undefined) {
          const maxTurnOrder = Number(
            (db.prepare(`SELECT COALESCE(MAX(turn_order), 0) AS m FROM turns`).get() as { m: number | bigint }).m,
          );
          db.prepare(
            `INSERT INTO turns (turn_id, turn_order, status, opened_at_event_order, closed_at_event_order)
             VALUES ('t-wrong', ?, 'closed', 0, 1)`,
          ).run(maxTurnOrder + 1);
          db.prepare(
            `UPDATE message SET turn_id = 't-wrong' WHERE message_id IN (
               SELECT m.message_id FROM message m
               JOIN message_block b ON b.message_id = m.message_id
               WHERE b.block_type = 'tool_call' AND json_extract(b.content, '$.toolCallId') = 'call-wt'
             )`,
          ).run();
        } else {
          db.prepare(
            `UPDATE message SET turn_id = ? WHERE message_id IN (
               SELECT m.message_id FROM message m
               JOIN message_block b ON b.message_id = m.message_id
               WHERE b.block_type = 'tool_call' AND json_extract(b.content, '$.toolCallId') = 'call-wt'
             )`,
          ).run(other.turn_id);
        }
      } finally {
        db.close();
      }
    });
  });

  it("at-or-before compact point: advance compact_point past pair (corrupt_state_fixture) — declines into ordinary compact, no mutation", async () => {
    // not_in_open_tail is reachable only when compact_point advances past an
    // already-captured pair (view install / manual compact_point). Normal
    // intake never places a live open-turn pair at/before compact point without
    // a compact install; this corrupt_state_fixture models post-compact residual.
    await assertDeclinesWithoutMutation("before-compact-point", "call-bcp", "corrupt_state_fixture", (filePath) => {
      const db = openRaw(filePath);
      try {
        const maxOrder = Number(
          (db.prepare(`SELECT COALESCE(MAX(source_event_order), 0) AS m FROM message`).get() as { m: number | bigint })
            .m,
        );
        const hasView = db.prepare(`SELECT 1 AS n FROM thread_view WHERE singleton = 1`).get() as
          | { n: number }
          | undefined;
        if (hasView !== undefined) {
          db.prepare(`UPDATE thread_view SET compact_point = ? WHERE singleton = 1`).run(maxOrder + 1);
        } else {
          db.prepare(
            `INSERT INTO thread_view (
               singleton, view_id, created_at, compact_point, covered_from,
               profile_name, config_json, arrangement_json, gaps_json, source_state_json
             ) VALUES (1, 'v-test', ?, ?, 0, NULL, '{}', '[]', '[]', '{}')`,
          ).run(new Date().toISOString(), maxOrder + 1);
        }
      } finally {
        db.close();
      }
    });
  });

  it("unreadable payload: non-string tool_result content (corrupt_state_fixture) — declines into ordinary compact, no mutation", async () => {
    await assertDeclinesWithoutMutation("unreadable", "call-ur", "corrupt_state_fixture", (filePath) => {
      const db = openRaw(filePath);
      try {
        db.prepare(
          `UPDATE message_block SET content = ?
           WHERE block_type = 'tool_result'
             AND json_extract(content, '$.toolCallId') = 'call-ur'`,
        ).run(JSON.stringify({ toolCallId: "call-ur", content: 123, isError: false }));
      } finally {
        db.close();
      }
    });
  });

  it("tool_call_id_mismatch: duplicate-key JSON (extract first, parse last) — unit + runtime", async () => {
    // SQLite json_extract returns the first duplicate key; JSON.parse returns the last.
    const dupKeyCall = `{"toolCallId":"call-mm","toolCallId":"call-other","toolName":"read_file","arguments":{"path":"x"}}`;
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedPendingToolTurn(fixture.filePath, "call-mm");
    const db = openRaw(fixture.filePath);
    try {
      db.prepare(
        `UPDATE message_block SET content = ?
         WHERE block_type = 'tool_call'
           AND json_extract(content, '$.toolCallId') = 'call-mm'`,
      ).run(dupKeyCall);
      // extract still sees call-mm (first key)
      const extract = db
        .prepare(
          `SELECT json_extract(content, '$.toolCallId') AS id FROM message_block
           WHERE block_type = 'tool_call' AND json_extract(content, '$.toolCallId') = 'call-mm'`,
        )
        .get() as { id: string };
      expect(extract.id).toBe("call-mm");
      expect(JSON.parse(dupKeyCall).toolCallId).toBe("call-other");
      const proof = provePendingToolPair(db, "call-mm");
      expect(proof.ok).toBe(false);
      if (!proof.ok) expect(proof.reason).toBe("tool_call_id_mismatch");
    } finally {
      db.close();
    }

    await assertDeclinesWithoutMutation("id-mismatch", "call-mm2", "corrupt_state_fixture", (filePath) => {
      const d = openRaw(filePath);
      try {
        d.prepare(
          `UPDATE message_block SET content = ?
           WHERE block_type = 'tool_call'
             AND json_extract(content, '$.toolCallId') = 'call-mm2'`,
        ).run(`{"toolCallId":"call-mm2","toolCallId":"call-other","toolName":"read_file","arguments":{"path":"x"}}`);
      } finally {
        d.close();
      }
    });
  });

  it("valid pair: above-trigger preserve path claims then releases; pair intact", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedPendingToolTurn(fixture.filePath, "call-ok-above");
    const beforeMarkers = snapshotCanonical(fixture.filePath).markerCount;
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "pair-valid-above",
        continuation: {
          kind: "pending_correlated_tool_result",
          protectedToolCallIds: ["call-ok-above"],
          correlationValid: true,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(["compact_preserve_tool", "degraded_compact", "no_reduction"]).toContain(result.value.receipt.outcome);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
    expect(snapshotCanonical(fixture.filePath).markerCount).toBe(beforeMarkers);
    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const pair = listed.value.filter(
      (m) =>
        (m.kind === "tool_call" || m.kind === "tool_result") &&
        m.blocks.some((b) => b.content["toolCallId"] === "call-ok-above"),
    );
    expect(pair).toHaveLength(2);
  });
});

describe("LIM-61 evidence: marker-event → boundary-status crash gap", () => {
  it("interruptAfterMarkerEvent: resume reconciles marker status, no second marker, completes", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);

    const interrupted = await runCCTest(fixture.filePath, baseFacts({ attemptId: "marker-event-gap-1" }), {
      interruptAfterMarkerEvent: true,
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const cTurnId = interrupted.value.continuationTurnId!;
    expect(cTurnId).toMatch(/^t\d+$/);

    // Marker event exists; boundary status may still say markerPersisted false.
    const markerKey = compactContinuationMarkerIdempotencyKey(cTurnId);
    const events = await intakeStream.listEvents({ filePath: fixture.filePath });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.filter((e) => e.idempotencyKey === markerKey)).toHaveLength(1);

    const pending = await compactContinuation.getPendingCompactContinuationBoundary({
      filePath: fixture.filePath,
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value?.status).toBe("pending");
    // Gap: status not yet marker_persisted.
    expect(pending.value?.markerPersisted).toBe(false);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "lhc", attemptId: "marker-event-gap-1" });

    const stagesBefore = await compactContinuation.listCompactContinuationStages(
      { filePath: fixture.filePath },
      "marker-event-gap-1",
    );
    expect(stagesBefore.ok).toBe(true);
    if (!stagesBefore.ok) return;
    expect(
      stagesBefore.value.some((s) => s.stage === "interrupted" && s.detail?.["after"] === "marker_event_commit"),
    ).toBe(true);

    // Resume: detect marker by key, reconcile status, no second marker, complete.
    const resumed = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "marker-event-gap-1", writerClaim: "lhc" }),
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.forcedBoundaryThisAttempt).toBe(false);
    expect(resumed.value.continuationTurnId).toBe(cTurnId);
    expect(["compact_continue_turn", "degraded_compact", "no_reduction"]).toContain(resumed.value.receipt.outcome);
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
    expect(resumed.value.pendingBoundary).toBeNull();

    const eventsAfter = await intakeStream.listEvents({ filePath: fixture.filePath });
    expect(eventsAfter.ok).toBe(true);
    if (!eventsAfter.ok) return;
    expect(eventsAfter.value.filter((e) => e.idempotencyKey === markerKey)).toHaveLength(1);

    const stagesAfter = await compactContinuation.listCompactContinuationStages(
      { filePath: fixture.filePath },
      "marker-event-gap-1",
    );
    expect(stagesAfter.ok).toBe(true);
    if (!stagesAfter.ok) return;
    expect(stagesAfter.value.some((s) => s.stage === "marker_persisted")).toBe(true);
    expect(stagesAfter.value.some((s) => s.stage === "writer_released")).toBe(true);
    // Append-only: interrupt stage still present.
    expect(
      stagesAfter.value.some((s) => s.stage === "interrupted" && s.detail?.["after"] === "marker_event_commit"),
    ).toBe(true);
  });
});

describe("LIM-61 evidence: marker-delta source fingerprint", () => {
  async function prepareWithOpenContinuation(filePath: string) {
    // Force a real continue-turn boundary + open continuation turn, then prepare.
    const forced = await runCCTest(filePath, baseFacts({ attemptId: "prep-force" }), {
      interruptAfterBoundary: true,
    });
    if (!forced.ok) throw new Error(forced.error.reason);
    const continuationTurnId = forced.value.continuationTurnId!;
    // Release writer for prepare/install tests (we only need the open turn + later marker).
    const db = openRaw(filePath);
    try {
      db.prepare(
        `UPDATE compact_continuation_writer SET claim = 'none', attempt_id = NULL, claimed_at = NULL WHERE singleton = 1`,
      ).run();
    } finally {
      db.close();
    }
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const prep = await sdk.threadView.prepareCompact(
      { filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    if (!prep.ok) throw new Error(prep.error.reason);
    const viewBefore = snapshotCanonical(filePath).viewId;
    return { prepared: prep.value, continuationTurnId, viewBefore };
  }

  it("marker and source changes after prepare do not block activation", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const { prepared, continuationTurnId, viewBefore } = await prepareWithOpenContinuation(fixture.filePath);
    const markerKey = compactContinuationMarkerIdempotencyKey(continuationTurnId);

    // Append exactly one valid marker for the open continuation turn.
    const markerBatch = await intakeStream.messageEvents({ filePath: fixture.filePath }, [
      validEvent("compact_continuation_marker", {
        idempotencyKey: markerKey,
        payload: {
          kind: "lhc.compact_continuation",
          continuationTurnId,
          cause: "context_compacted_task_in_progress",
          action: "continue_existing_task",
          newUserRequest: false,
          waitForUser: false,
        },
      }),
    ]);
    expect(markerBatch.ok).toBe(true);
    if (!markerBatch.ok) return;

    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });

    // Positive: marker-only delta installs.
    const okInstall = await sdk.threadView.installPreparedCompact({ filePath: fixture.filePath }, prepared);
    expect(okInstall.ok).toBe(true);
    if (!okInstall.ok) return;

    // Fresh prepare for negative path (prior install changed view).
    const fixture2 = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture2.filePath);
    const prep2 = await prepareWithOpenContinuation(fixture2.filePath);
    const key2 = compactContinuationMarkerIdempotencyKey(prep2.continuationTurnId);
    const marker2 = await intakeStream.messageEvents({ filePath: fixture2.filePath }, [
      validEvent("compact_continuation_marker", {
        idempotencyKey: key2,
        payload: {
          kind: "lhc.compact_continuation",
          continuationTurnId: prep2.continuationTurnId,
          cause: "context_compacted_task_in_progress",
          action: "continue_existing_task",
          newUserRequest: false,
          waitForUser: false,
        },
      }),
    ]);
    expect(marker2.ok).toBe(true);
    if (!marker2.ok) return;

    // Mutate a different source message/block without adding an event.
    const db = openRaw(fixture2.filePath);
    try {
      const row = db
        .prepare(
          `SELECT message_id FROM message
           WHERE kind = 'tool_result' AND deleted_at IS NULL
           ORDER BY source_event_order DESC LIMIT 1`,
        )
        .get() as { message_id: string } | undefined;
      expect(row).toBeDefined();
      db.prepare(
        `UPDATE message_block SET content = json_set(content, '$.content', 'TAMPERED-BLOCK')
         WHERE message_id = ? AND block_type = 'tool_result'`,
      ).run(row!.message_id);
    } finally {
      db.close();
    }

    const activated = await sdk.threadView.installPreparedCompact({ filePath: fixture2.filePath }, prep2.prepared);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(snapshotCanonical(fixture2.filePath).viewId).toBe(activated.value.viewId);
    void viewBefore;
  });

  it("derivation changes after prepare do not block activation", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    // derivedThreadFixture drains work so ready derivation rows exist.
    const fixture = await derivedThreadFixture(store, { failures: false });
    const db0 = openRaw(fixture.filePath);
    let d: { subject_kind: string; subject_id: string; derivation_type: string; content: string | null };
    try {
      const row = db0
        .prepare(
          `SELECT subject_kind, subject_id, derivation_type, content FROM derivation
           WHERE state = 'ready' AND content IS NOT NULL LIMIT 1`,
        )
        .get() as typeof d | undefined;
      expect(row).toBeDefined();
      d = row!;
    } finally {
      db0.close();
    }
    const prep = await sdk.threadView.prepareCompact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const db = openRaw(fixture.filePath);
    try {
      const changed = db
        .prepare(`UPDATE derivation SET content = ? WHERE subject_kind = ? AND subject_id = ? AND derivation_type = ?`)
        .run(`${d.content}-MUTATED`, d.subject_kind, d.subject_id, d.derivation_type);
      expect(Number(changed.changes)).toBe(1);
    } finally {
      db.close();
    }
    const activated = await sdk.threadView.installPreparedCompact({ filePath: fixture.filePath }, prep.value);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(snapshotCanonical(fixture.filePath).viewId).toBe(activated.value.viewId);
  });

  it("message changes after prepare do not block activation", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const fixture = await derivedThreadFixture(store, { failures: false });
    const listed = await messages.list({ filePath: fixture.filePath });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Prefer assistant_text / tool_result — not turn-initiating user_prompt.
    const removable = listed.value.find((m) => m.kind === "assistant_text" || m.kind === "tool_result");
    expect(removable).toBeDefined();
    const prep = await sdk.threadView.prepareCompact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const removed = await messages.remove({ filePath: fixture.filePath }, { messageId: removable!.messageId });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const activated = await sdk.threadView.installPreparedCompact({ filePath: fixture.filePath }, prep.value);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(snapshotCanonical(fixture.filePath).viewId).toBe(activated.value.viewId);
  });

  it("a second coherent prepared view can replace the first", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const fixtureV = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixtureV.filePath);
    const prepA = await sdk.threadView.prepareCompact(
      { filePath: fixtureV.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(prepA.ok).toBe(true);
    if (!prepA.ok) return;
    const prepB = await sdk.threadView.prepareCompact(
      { filePath: fixtureV.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(prepB.ok).toBe(true);
    if (!prepB.ok) return;
    const instA = await sdk.threadView.installPreparedCompact({ filePath: fixtureV.filePath }, prepA.value);
    expect(instA.ok).toBe(true);
    if (!instA.ok) return;
    const viewAfterA = snapshotCanonical(fixtureV.filePath).viewId;
    expect(viewAfterA).toBe(instA.value.viewId);
    const instB = await sdk.threadView.installPreparedCompact({ filePath: fixtureV.filePath }, prepB.value);
    expect(instB.ok).toBe(true);
    if (!instB.ok) return;
    expect(snapshotCanonical(fixtureV.filePath).viewId).toBe(instB.value.viewId);
  });

  it("compact-install-before-validate runs inside a write transaction", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const fixtureInj = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixtureInj.filePath);
    const prepInj = await sdk.threadView.prepareCompact(
      { filePath: fixtureInj.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(prepInj.ok).toBe(true);
    if (!prepInj.ok) return;
    let nestedBeginError: string | null = null;
    setViewInjectionHook("compact-install-before-validate", (ctx) => {
      expect(ctx?.db).toBeDefined();
      // node:sqlite has no public inTransaction flag; nested BEGIN fails only inside a txn.
      try {
        ctx!.db.exec("BEGIN IMMEDIATE");
        nestedBeginError = "nested_begin_succeeded";
      } catch (cause) {
        nestedBeginError = cause instanceof Error ? cause.message : String(cause);
      }
    });
    try {
      const inst = await sdk.threadView.installPreparedCompact({ filePath: fixtureInj.filePath }, prepInj.value);
      expect(inst.ok).toBe(true);
      expect(nestedBeginError).toMatch(/transaction within a transaction/i);
    } finally {
      setViewInjectionHook("compact-install-before-validate", null);
    }
  });

  it("message excerpt source changes after prepare do not block activation", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Several closed undrained turns so smooth band uses message_excerpt (no chunk membership yet).
    for (let i = 0; i < 4; i++) {
      const batch = await intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: `undrained turn ${i} unique-excerpt-marker-${i}` } }),
        validEvent("assistant_text", { payload: { text: `reply ${i} `.repeat(30) } }),
        validEvent("turn_end", { payload: { outcome: "completed" } }),
      ]);
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
    }
    await intakeStream.messageEvents({ filePath }, [
      validEvent("user_prompt", { payload: { text: "open tail" } }),
      validEvent("assistant_text", { payload: { text: "still open" } }),
    ]);
    const prep = await sdk.threadView.prepareCompact(
      { filePath },
      { params: { lowerBound: 200, percentages: { full: 10, smooth: 70, detailed: 10, brief: 10 } } },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const smoothBand = prep.value.bands.find((b) => b.band === "smooth");
    expect(smoothBand).toBeDefined();
    expect(smoothBand!.renderedText).toMatch(/unique-excerpt-marker-/);
    expect(prep.value.selectedSourceTurnIds.length).toBeGreaterThan(0);
    // Positive: no drift installs.
    const ok = await sdk.threadView.installPreparedCompact({ filePath }, prep.value);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;

    // Fresh prepare for mutation path.
    const prep2 = await sdk.threadView.prepareCompact(
      { filePath },
      { params: { lowerBound: 200, percentages: { full: 10, smooth: 70, detailed: 10, brief: 10 } } },
    );
    expect(prep2.ok).toBe(true);
    if (!prep2.ok) return;
    expect(prep2.value.bands.find((b) => b.band === "smooth")?.renderedText).toMatch(/unique-excerpt-marker-/);
    const db = openRaw(filePath);
    try {
      const row = db
        .prepare(
          `SELECT m.message_id FROM message m
           JOIN message_block b ON b.message_id = m.message_id
           WHERE m.kind = 'user_prompt' AND b.content LIKE '%unique-excerpt-marker-3%'
           LIMIT 1`,
        )
        .get() as { message_id: string } | undefined;
      expect(row).toBeDefined();
      db.prepare(
        `UPDATE message_block SET content = json_set(content, '$.text', 'MUTATED-EXCERPT-SOURCE')
         WHERE message_id = ?`,
      ).run(row!.message_id);
    } finally {
      db.close();
    }
    const activated = await sdk.threadView.installPreparedCompact({ filePath }, prep2.value);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(snapshotCanonical(filePath).viewId).toBe(activated.value.viewId);
  });

  it("source block changes after prepare do not block activation", async () => {
    const sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const prep = await sdk.threadView.prepareCompact(
      { filePath: fixture.filePath },
      { params: { lowerBound: 400, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } } },
    );
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    const db = openRaw(fixture.filePath);
    try {
      db.prepare(
        `UPDATE message_block SET content = json_set(content, '$.text', 'BLOCK-MUT')
         WHERE message_id IN (
           SELECT message_id FROM message WHERE kind = 'assistant_text' AND deleted_at IS NULL
           ORDER BY source_event_order DESC LIMIT 1
         )`,
      ).run();
    } finally {
      db.close();
    }
    const activated = await sdk.threadView.installPreparedCompact({ filePath: fixture.filePath }, prep.value);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(snapshotCanonical(fixture.filePath).viewId).toBe(activated.value.viewId);
  });
});

describe("LIM-61 evidence: invalid candidate without material hooks", () => {
  it("unresolved tool_call at settled active_non_tool: bounded retry / failed_repairable", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    // Normal pipeline: open turn with tool_call and NO result (unresolved).
    const batch = await intakeStream.messageEvents({ filePath: fixture.filePath }, [
      validEvent("user_prompt", { payload: { text: "please use a tool" } }),
      validEvent("assistant_text", { payload: { text: "calling" } }),
      validEvent("tool_call", {
        payload: { toolCallId: "call-unresolved", toolName: "read_file", arguments: { path: "a.txt" } },
      }),
    ]);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;

    const before = snapshotCanonical(fixture.filePath);
    const result = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({
        attemptId: "invalid-candidate-1",
        continuation: { kind: "active_non_tool" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt.outcome).toBe("retry_compact");
    expect(result.value.receipt.refused).toBe(false);
    expect(result.value.receipt.warnings.map((w) => w.code)).toEqual(["compact_attempt_failed"]);
    expect(result.value.receipt.retry).toMatchObject({ attemptIndex: 1, retryAuthorized: true });
    // The relief failed; the session keeps working on the body it already has.
    expect(result.value.nextProviderRequestAllowed).toBe(true);
    expect(result.value.decision.transitionPath.some((s) => String(s).includes("compact"))).toBe(true);
    expect(result.value.pendingBoundary?.status).toBe("failed_repairable");
    expect(result.value.pendingBoundary?.lastStage).toBe("compact_failed");
    expect(result.value.pendingBoundary?.attemptId).toBe("invalid-candidate-1");
    expect(writerClaimOf(fixture.filePath)).toEqual({ claim: "none", attemptId: null });
    expect(result.value.compactReceipt).toBeNull();
    expect(snapshotCanonical(fixture.filePath).viewId).toBe(before.viewId);
    const stages = await compactContinuation.listCompactContinuationStages(
      { filePath: fixture.filePath },
      "invalid-candidate-1",
    );
    expect(stages.ok).toBe(true);
    if (!stages.ok) return;
    expect(stages.value.some((s) => s.stage === "compact_failed")).toBe(true);
    expect(stages.value.some((s) => s.stage === "install_failed")).toBe(false);
  });
});

describe("LIM-61 evidence: compact_failed vs install_failed labels", () => {
  it("failInstallBeforeWrite with valid structure → install_failed stage", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const failed = await runCCTest(fixture.filePath, baseFacts({ attemptId: "label-install" }), {
      failInstallBeforeWrite: true,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.pendingBoundary?.status).toBe("failed_repairable");
    expect(failed.value.pendingBoundary?.lastStage).toBe("install_failed");
    const stages = await compactContinuation.listCompactContinuationStages(
      { filePath: fixture.filePath },
      "label-install",
    );
    expect(stages.ok).toBe(true);
    if (!stages.ok) return;
    expect(stages.value.some((s) => s.stage === "install_failed")).toBe(true);
  });
});

describe("LIM-61 evidence: closed validation table", () => {
  const valid = baseFacts({ attemptId: "val-base" });

  it.each([
    ["top-level unknown", { ...valid, extra: true }, /unknown field hostFacts\.extra/],
    ["seam unknown", { ...valid, seam: { ...SETTLED_SEAM, extra: 1 } }, /unknown field seam\.extra/],
    [
      "providerUsage available unknown",
      {
        ...valid,
        providerUsage: {
          available: true,
          inputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          total: 1,
          domain: "provider_reported_input",
          bonus: 1,
        },
      },
      /unknown field providerUsage\.bonus/,
    ],
    [
      "providerUsage unavailable unknown",
      {
        ...valid,
        providerUsage: { available: false, reason: "missing", domain: "provider_reported_input", total: 1 },
      },
      /providerUsage\.total must not be present|unknown field/,
    ],
    [
      "postMeasurementEstimate unknown",
      {
        ...valid,
        postMeasurementEstimate: {
          tokens: 1,
          source: "x",
          domain: "source_labelled_estimate",
          extra: true,
        },
      },
      /unknown field postMeasurementEstimate\.extra/,
    ],
    [
      "policy unknown",
      {
        ...valid,
        policy: {
          upperTriggerTokens: 1,
          lowerTargetTokens: 1,
          hostCapability: "full_state_machine",
          extra: true,
        },
      },
      /unknown field policy\.extra/,
    ],
    [
      "continuation none extra",
      { ...valid, continuation: { kind: "none", x: 1 } },
      /unknown field continuation\.x|must not carry extra fields/,
    ],
    [
      "continuation active extra",
      { ...valid, continuation: { kind: "active_non_tool", x: 1 } },
      /must not carry extra fields|unknown field/,
    ],
    [
      "continuation tool missing fields",
      { ...valid, continuation: { kind: "pending_correlated_tool_result" } },
      /protectedToolCallIds/,
    ],
    [
      "compact unknown",
      { ...valid, compact: { profile: "continuation", weird: true } },
      /unknown field compact\.weird/,
    ],
    [
      "compact.params unknown",
      { ...valid, compact: { params: { lowerBound: 1, nope: true } } },
      /unknown field compact\.params\.nope/,
    ],
    [
      "percentages unknown",
      {
        ...valid,
        compact: { params: { percentages: { full: 25, smooth: 25, detailed: 25, brief: 25, mega: 1 } } },
      },
      /unknown field compact\.params\.percentages\.mega/,
    ],
    ["public testHooks", { ...valid, testHooks: { skipRealCompact: true } }, /unknown field hostFacts\.testHooks/],
    [
      "fractional inputTokens",
      {
        ...valid,
        providerUsage: {
          available: true,
          inputTokens: 1.5,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          total: 1,
          domain: "provider_reported_input",
        },
      },
      /non-negative integer/,
    ],
    ["negative epoch", { ...valid, seam: { ...SETTLED_SEAM, inputEpochAtDecision: -1 } }, /non-negative integers/],
    ["empty actor", { ...valid, actor: "" }, /actor and harness/],
    [
      "invalid domain",
      {
        ...valid,
        providerUsage: {
          available: true,
          inputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          total: 1,
          domain: "wrong",
        },
      },
      /provider_reported_input/,
    ],
    [
      "invalid capability",
      {
        ...valid,
        policy: { upperTriggerTokens: 1, lowerTargetTokens: 1, hostCapability: "magic" },
      },
      /hostCapability/,
    ],
    [
      "percentage sum not 100",
      {
        ...valid,
        compact: { params: { lowerBound: 100, percentages: { full: 10, smooth: 10, detailed: 10, brief: 10 } } },
      },
      /percentages must sum to 100/,
    ],
    [
      "lowerBound not positive int",
      { ...valid, compact: { params: { lowerBound: 0 } } },
      /lowerBound must be a positive integer/,
    ],
  ] as const)("%s", (_name, facts, pattern) => {
    const err = validateHostFacts(facts);
    expect(err?.code).toBe("invalid_compact_continuation_input");
    expect(err?.reason).toMatch(pattern);
  });

  it("valid facts pass closed validation", () => {
    expect(validateHostFacts(valid)).toBeUndefined();
    expect(
      validateHostFacts({
        ...valid,
        providerUsage: { available: false, reason: "invalid", domain: "provider_reported_input" },
      }),
    ).toBeUndefined();
  });
});

describe("LIM-61 evidence: storage invariants", () => {
  it("upsertBoundary owner mismatch throws and does not mutate", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const forced = await runCCTest(fixture.filePath, baseFacts({ attemptId: "own-a" }), {
      interruptAfterBoundary: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    const turnId = forced.value.continuationTurnId!;
    const db = openRaw(fixture.filePath);
    try {
      const before = db
        .prepare(`SELECT attempt_id, status FROM compact_continuation_boundary WHERE continuation_turn_id = ?`)
        .get(turnId) as { attempt_id: string; status: string };
      expect(before.attempt_id).toBe("own-a");
      expect(() =>
        upsertBoundary(db, {
          continuationTurnId: turnId,
          attemptId: "other-owner",
          status: "complete",
          markerPersisted: true,
          lastStage: "stolen",
          forcedAt: new Date().toISOString(),
        }),
      ).toThrow(/owned by/);
      const after = db
        .prepare(
          `SELECT attempt_id, status, last_stage FROM compact_continuation_boundary WHERE continuation_turn_id = ?`,
        )
        .get(turnId) as { attempt_id: string; status: string; last_stage: string };
      expect(after.attempt_id).toBe("own-a");
      expect(after.status).toBe(before.status);
      expect(after.last_stage).not.toBe("stolen");
    } finally {
      db.close();
    }
  });

  it("partial unique index rejects a second unresolved boundary", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const forced = await runCCTest(fixture.filePath, baseFacts({ attemptId: "uniq-1" }), {
      interruptAfterBoundary: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    const db = openRaw(fixture.filePath);
    try {
      expect(() => {
        db.prepare(
          `INSERT INTO compact_continuation_boundary (
             continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
           ) VALUES ('t-second', 'uniq-2', 'pending', 0, 'x', ?, NULL)`,
        ).run(new Date().toISOString());
      }).toThrow(/UNIQUE|unique/i);
    } finally {
      db.close();
    }
  });

  it("readPendingBoundary throws when index absent and two unresolved rows exist", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const forced = await runCCTest(fixture.filePath, baseFacts({ attemptId: "corr-1" }), {
      interruptAfterBoundary: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    const db = openRaw(fixture.filePath);
    try {
      db.exec(`DROP INDEX IF EXISTS idx_compact_continuation_boundary_one_unresolved`);
      db.prepare(
        `INSERT INTO compact_continuation_boundary (
           continuation_turn_id, attempt_id, status, marker_persisted, last_stage, forced_at, completed_at
         ) VALUES ('t-second', 'corr-2', 'pending', 0, 'x', ?, NULL)`,
      ).run(new Date().toISOString());
      expect(() => readPendingBoundary(db)).toThrow(/corruption|unresolved boundaries/i);
    } finally {
      db.close();
    }
  });

  it("nonterminal receipt updates do not erase append-only stage/posture history", async () => {
    const fixture = await derivedThreadFixture(store, { failures: false });
    await seedOpenAgenticTurn(fixture.filePath);
    const failed = await runCCTest(fixture.filePath, baseFacts({ attemptId: "hist-1" }), {
      failInstallBeforeWrite: true,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.pendingBoundary?.status).toBe("failed_repairable");
    const stages1 = await compactContinuation.listCompactContinuationStages({ filePath: fixture.filePath }, "hist-1");
    expect(stages1.ok).toBe(true);
    if (!stages1.ok) return;
    const n1 = stages1.value.length;
    expect(stages1.value.some((s) => s.stage === "retry_posture")).toBe(true);
    expect(stages1.value.some((s) => s.stage === "claimed_writer")).toBe(true);

    const repaired = await compactContinuation.runCompactContinuation(
      { filePath: fixture.filePath },
      baseFacts({ attemptId: "hist-1", writerClaim: "none" }),
    );
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) return;
    const stages2 = await compactContinuation.listCompactContinuationStages({ filePath: fixture.filePath }, "hist-1");
    expect(stages2.ok).toBe(true);
    if (!stages2.ok) return;
    expect(stages2.value.length).toBeGreaterThan(n1);
    // Prior stages still present (append-only).
    expect(stages2.value.filter((s) => s.stage === "retry_posture").length).toBeGreaterThanOrEqual(2);
    expect(stages2.value.some((s) => s.stage === "claimed_writer")).toBe(true);
  });
});

describe("LIM-61 evidence: public export surface", () => {
  it("public compactContinuation module and package index do not export runCompactContinuationForTests", async () => {
    const publicMod = await import("../src/compact-continuation/index.js");
    expect("runCompactContinuationForTests" in publicMod).toBe(false);
    expect("CompactContinuationTestHooks" in publicMod).toBe(false);
    const sdk = await import("../src/index.js");
    expect("runCompactContinuationForTests" in sdk).toBe(false);
    // Runtime: nested domain from initLhc
    const lhc = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    expect("runCompactContinuationForTests" in lhc.compactContinuation).toBe(false);
    // Fixtures path still has it.
    const fixtures = await import("./fixtures/compact-continuation-seam.js");
    expect(typeof fixtures.runCompactContinuationForTests).toBe("function");
  });
});

describe("LIM-61 evidence: schema version current", () => {
  it("fresh threads are schema v12", async () => {
    const filePath = store.threadPath();
    const created = await threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const db = openRaw(filePath);
    try {
      const v = Number((db.prepare(`PRAGMA user_version`).get() as { user_version: number | bigint }).user_version);
      expect(v).toBe(CURRENT_THREAD_SCHEMA_VERSION);
      expect(v).toBe(12);
      const idx = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_compact_continuation_boundary_one_unresolved'`,
        )
        .get();
      expect(idx).toBeDefined();
    } finally {
      db.close();
    }
  });
});
