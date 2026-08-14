/**
 * LIM-64: post-measurement estimate must commit only after replay dedupe and
 * successful intake. Direct observeRolloutLine tests are insufficient — this
 * drives real startCaptureSession with replay signatures and a lifecycle sink.
 */

import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Lhc, MessageEventInput, ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";

import { loadThreadSignatures, openLineageDatabase, recordSessionThread } from "../../src/intake/lineage-db.js";
import { signaturesForRolloutLine } from "../../src/intake/replay-dedupe.js";
import { startCaptureSession } from "../../src/intake/session.js";
import {
  HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
  hostEstimateFromCanonicalBytes,
  PROVIDER_OUTPUT_ESTIMATE_SOURCE,
} from "../../src/observation/estimate.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > capMs) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}

function appendJsonl(path: string, item: RolloutLineItem): void {
  appendFileSync(path, `${JSON.stringify(item)}\n`);
}

function userLine(sid: string, uuid: string, text: string): RolloutLineItem {
  return {
    type: "user",
    uuid,
    sessionId: sid,
    message: { role: "user", content: text },
  };
}

function toolResultLine(sid: string, uuid: string, toolUseId: string, content: string): RolloutLineItem {
  return {
    type: "user",
    uuid,
    sessionId: sid,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

function completeAssistant(
  sid: string,
  uuid: string,
  requestId: string,
  text: string,
  usage: Record<string, number>,
): RolloutLineItem {
  return {
    type: "assistant",
    uuid,
    sessionId: sid,
    requestId,
    message: {
      role: "assistant",
      id: `msg_${uuid}`,
      model: "claude-test",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage,
    },
  };
}

function fakeSdk(
  intake: MessageEventInput[],
  options: {
    onCall?: (events: MessageEventInput[]) => void;
    /** Per-event outcome override by idempotency key (default recorded). */
    outcomeByKey?: (key: string, event: MessageEventInput, index: number) => "recorded" | "skipped";
    /** Return a malformed BatchResult (length/key) for map-fail tests. */
    malformed?: "length" | "key" | "order";
    fail?: boolean;
  } = {},
): Lhc {
  return {
    intakeStream: {
      messageEvents: async (_ref: ThreadRef, events: MessageEventInput[]) => {
        options.onCall?.(events);
        if (options.fail) {
          return {
            ok: false as const,
            error: { code: "TEST_INTAKE", reason: "injected intake failure" },
          };
        }
        intake.push(...events);
        if (options.malformed === "length") {
          return {
            ok: true as const,
            value: {
              events: events.slice(0, Math.max(0, events.length - 1)).map((e) => ({
                idempotencyKey: e.idempotencyKey,
                outcome: "recorded" as const,
              })),
            },
          };
        }
        if (options.malformed === "key") {
          return {
            ok: true as const,
            value: {
              events: events.map((e, i) => ({
                idempotencyKey: i === 0 ? "wrong-key" : e.idempotencyKey,
                outcome: "recorded" as const,
              })),
            },
          };
        }
        if (options.malformed === "order") {
          // Same keys, reversed order — must fail closed (input-order alignment).
          const reversed = [...events].reverse();
          return {
            ok: true as const,
            value: {
              events: reversed.map((e) => ({
                idempotencyKey: e.idempotencyKey,
                outcome: "recorded" as const,
              })),
            },
          };
        }
        return {
          ok: true as const,
          value: {
            events: events.map((e, i) => ({
              idempotencyKey: e.idempotencyKey,
              outcome: options.outcomeByKey?.(e.idempotencyKey, e, i) ?? ("recorded" as const),
            })),
          },
        };
      },
    },
    drainSettled: async () => {},
    inspect: { overview: async () => ({ ok: true, value: { derivation: { pending: 0 } } }) },
  } as unknown as Lhc;
}

describe("startCaptureSession estimate after replay dedupe + intake", () => {
  it("re-tail of already-captured tool/user lines adds zero estimate; novel lines add once", async () => {
    // Phase 1: capture sampling + tool + user into LHC and lineage signatures.
    // Phase 2: restart capture on the same file/thread with signatures loaded;
    //          full re-tail must skip replayed events (zero estimate), then a
    //          novel line must add exactly once after successful intake.
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-est-dedupe-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/est-dedupe";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(path, "");

    const toolBody = "T".repeat(8_000); // 8000 bytes → 2000 tokens
    const userText = "U".repeat(4_000); // 4000 bytes → 1000 tokens
    const lineageDbPath = join(root, "lineage.sqlite");
    const registryPath = join(root, "reg.sqlite");
    const threadId = "th_est";

    openLineageDatabase(lineageDbPath);
    recordSessionThread(lineageDbPath, sid, threadId, {}, { prefix: { kind: "none" } });

    const intake1: MessageEventInput[] = [];
    const lifecycle1: LifecycleSignal[] = [];
    const session1 = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => {
        lifecycle1.push(...signals);
      },
      createThreadFn: async () => ({
        ok: true,
        value: { threadId, registryPath } as ThreadRef,
      }),
      initSdkFn: () => fakeSdk(intake1),
    });

    try {
      await waitFor(() => session1.isCaptureReady(), "phase1 ready");
      appendJsonl(
        path,
        completeAssistant(sid, "asst-1", "req_est_1", "hello", {
          input_tokens: 10_000,
          output_tokens: 40,
        }),
      );
      appendJsonl(path, toolResultLine(sid, "tr-1", "toolu_1", toolBody));
      appendJsonl(path, userLine(sid, "u-1", userText));
      await waitFor(
        () =>
          lifecycle1.some((s) => s.kind === "post_measurement_estimate" && s.mode === "set") &&
          lifecycle1.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "add").length >= 2,
        "phase1 estimates",
      );
      expect(session1.stats.eventsSent).toBeGreaterThan(0);
    } finally {
      await session1.stop();
    }

    const sigs = loadThreadSignatures(lineageDbPath, threadId);
    expect(sigs.length).toBeGreaterThan(0);
    // Sanity: tool + user signatures are among those persisted.
    for (const line of [toolResultLine(sid, "tr-1", "toolu_1", toolBody), userLine(sid, "u-1", userText)]) {
      for (const sig of signaturesForRolloutLine(line, 0)) {
        expect(sigs).toContain(sig);
      }
    }

    // Phase 2: re-open same rollout from byte 0 with existing-thread signatures.
    // Replay window is active until the first novel event; re-tailed history must
    // not inflate post-measurement estimate.
    const intake2: MessageEventInput[] = [];
    const lifecycle2: LifecycleSignal[] = [];
    const session2 = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "explicit_resume" },
      knownRolloutPath: path,
      resumeSessionId: sid,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => {
        lifecycle2.push(...signals);
      },
      createThreadFn: async () => ({
        ok: true,
        value: { threadId, registryPath } as ThreadRef,
      }),
      initSdkFn: () => fakeSdk(intake2),
    });

    try {
      await waitFor(() => session2.isCaptureReady(), "phase2 ready");
      // After initial catch-up of the whole file, skippedReplay should cover history.
      expect(session2.stats.skippedReplay).toBeGreaterThan(0);
      // No estimate adds for re-tailed tool/user (and sampling dedupe blocks re-seed).
      const addsOnRetail = lifecycle2.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "add");
      expect(addsOnRetail).toHaveLength(0);
      // Re-tail publishes no turn_settled and no mode:set (deferred pressure dropped).
      expect(lifecycle2.filter((s) => s.kind === "turn_settled")).toHaveLength(0);
      expect(lifecycle2.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "set")).toHaveLength(0);
      // Re-tail must not re-intake the large bodies.
      expect(JSON.stringify(intake2)).not.toContain(toolBody.slice(0, 40));
      expect(JSON.stringify(intake2)).not.toContain(userText.slice(0, 40));

      // Novel content after replay window still needs a new authoritative sampling
      // first: complete a new sampling so post-measurement adds are eligible, then
      // a novel tool line must add exactly once.
      lifecycle2.length = 0;
      appendJsonl(
        path,
        completeAssistant(sid, "asst-2", "req_est_2", "next", {
          input_tokens: 11_000,
          output_tokens: 7,
        }),
      );
      await waitFor(
        () =>
          lifecycle2.some(
            (s) =>
              s.kind === "post_measurement_estimate" &&
              s.mode === "set" &&
              s.source === PROVIDER_OUTPUT_ESTIMATE_SOURCE &&
              s.tokens === 7,
          ),
        "phase2 mode set",
      );

      const novelBody = "N".repeat(4_000); // 1000 tokens
      appendJsonl(path, toolResultLine(sid, "tr-novel", "toolu_2", novelBody));
      await waitFor(
        () =>
          lifecycle2.some(
            (s) =>
              s.kind === "post_measurement_estimate" &&
              s.mode === "add" &&
              s.source === HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE &&
              s.tokens === 1_000,
          ),
        "novel tool add",
      );
      const novelAdds = lifecycle2.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "add");
      expect(novelAdds).toHaveLength(1);
      expect(JSON.stringify(intake2)).toContain(novelBody.slice(0, 40));
    } finally {
      await session2.stop();
    }
  });

  it("intake failure after candidate estimate publishes neither add nor turn_settled", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-est-fail-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/est-fail";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(path, "");

    const lifecycle: LifecycleSignal[] = [];
    let failNextIntake = false;
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(root, "lineage.sqlite"),
      registryPath: join(root, "reg.sqlite"),
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => {
        lifecycle.push(...signals);
      },
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_fail", registryPath: join(root, "reg.sqlite") } as ThreadRef,
      }),
      initSdkFn: () =>
        ({
          intakeStream: {
            messageEvents: async (_ref: ThreadRef, events: MessageEventInput[]) => {
              if (failNextIntake) {
                return {
                  ok: false as const,
                  error: { code: "TEST_INTAKE", reason: "injected intake failure" },
                };
              }
              return {
                ok: true as const,
                value: {
                  events: events.map((e) => ({ idempotencyKey: e.idempotencyKey, outcome: "recorded" as const })),
                },
              };
            },
          },
          drainSettled: async () => {},
          inspect: { overview: async () => ({ ok: true, value: { derivation: { pending: 0 } } }) },
        }) as unknown as Lhc,
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      lifecycle.length = 0;

      appendJsonl(
        path,
        completeAssistant(sid, "a1", "req_fail", "ok", {
          input_tokens: 1_000,
          output_tokens: 5,
        }),
      );
      await waitFor(
        () => lifecycle.some((s) => s.kind === "post_measurement_estimate" && s.mode === "set"),
        "mode set",
      );

      failNextIntake = true;
      const beforeAdds = lifecycle.filter((s) => s.kind === "post_measurement_estimate").length;
      const beforeSettled = lifecycle.filter((s) => s.kind === "turn_settled").length;

      appendJsonl(path, userLine(sid, "u-fail", "X".repeat(8_000)));
      await sleep(400);

      expect(lifecycle.filter((s) => s.kind === "post_measurement_estimate").length).toBe(beforeAdds);
      expect(lifecycle.filter((s) => s.kind === "turn_settled").length).toBe(beforeSettled);
      expect(session.getCaptureHealth().phase === "degraded" || session.isCaptureReady() === false).toBe(true);
    } finally {
      await session.stop();
    }
  });

  it("catch-up batch with many novel lines uses one SDK intake call", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-est-batch-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/est-batch";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "dddddddd-eeee-ffff-0000-111111111111";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);

    // Pre-write a multi-line rollout so the watcher's initial catch-up delivers
    // the whole snapshot as ONE emission batch (see watcher deliver).
    const lines: RolloutLineItem[] = [
      userLine(sid, "u-batch-open", "start"),
      completeAssistant(sid, "a-batch", "req_batch", "done", {
        input_tokens: 5_000,
        output_tokens: 9,
      }),
    ];
    for (let i = 0; i < 12; i += 1) {
      lines.push(userLine(sid, `u-batch-${i}`, `payload-${i}-` + "X".repeat(200)));
    }
    writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

    const intake: MessageEventInput[] = [];
    let intakeCalls = 0;
    const lifecycle: LifecycleSignal[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(root, "lineage.sqlite"),
      registryPath: join(root, "reg.sqlite"),
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => {
        lifecycle.push(...signals);
      },
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_batch", registryPath: join(root, "reg.sqlite") } as ThreadRef,
      }),
      initSdkFn: () =>
        fakeSdk(intake, {
          onCall: () => {
            intakeCalls += 1;
          },
        }),
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      await waitFor(() => lifecycle.some((s) => s.kind === "turn_settled"), "settled after catch-up");
      // Whole-batch intake: one messageEvents call for the catch-up batch, not per line.
      expect(intakeCalls).toBe(1);
      expect(intake.length).toBeGreaterThan(10);
      // mode:add only once per novel content line that recorded (user lines after sampling).
      const adds = lifecycle.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "add");
      expect(adds.length).toBeGreaterThanOrEqual(1);
    } finally {
      await session.stop();
    }
  });

  it("mixed recorded/skipped outcomes map by key; only recorded payload adds estimate", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-est-mixed-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/est-mixed";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "eeeeeeee-ffff-0000-1111-222222222222";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(path, "");

    const lifecycle: LifecycleSignal[] = [];
    const skippedBodies = new Set<string>();
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(root, "lineage.sqlite"),
      registryPath: join(root, "reg.sqlite"),
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => {
        lifecycle.push(...signals);
      },
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_mixed", registryPath: join(root, "reg.sqlite") } as ThreadRef,
      }),
      initSdkFn: () =>
        fakeSdk([], {
          outcomeByKey: (_key, event) => {
            const text =
              event.eventKind === "user_prompt" || event.eventKind === "tool_result"
                ? String(
                    (event.payload as { text?: string; content?: string }).text ??
                      (event.payload as { content?: string }).content ??
                      "",
                  )
                : "";
            if (text.includes("SKIP_ME")) {
              skippedBodies.add(text.slice(0, 20));
              return "skipped";
            }
            return "recorded";
          },
        }),
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      lifecycle.length = 0;
      appendJsonl(
        path,
        completeAssistant(sid, "a-mix", "req_mix", "ok", {
          input_tokens: 3_000,
          output_tokens: 4,
        }),
      );
      await waitFor(
        () => lifecycle.some((s) => s.kind === "post_measurement_estimate" && s.mode === "set"),
        "mode set",
      );

      // Skipped tool body must not contribute host-byte add; recorded user must.
      const skipBody = "SKIP_ME" + "S".repeat(8_000);
      const recordBody = "KEEP_ME" + "K".repeat(4_000);
      appendJsonl(path, toolResultLine(sid, "tr-skip", "toolu_skip", skipBody));
      appendJsonl(path, userLine(sid, "u-keep", recordBody));
      await waitFor(
        () => lifecycle.some((s) => s.kind === "post_measurement_estimate" && s.mode === "add"),
        "recorded add",
      );
      await sleep(200);

      const adds = lifecycle.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "add");
      // Only the recorded user line (~1000+ tokens from 4k+ bytes), not the skipped 8k tool.
      expect(adds).toHaveLength(1);
      const add0 = adds[0]!;
      expect(add0.kind).toBe("post_measurement_estimate");
      if (add0.kind === "post_measurement_estimate") {
        expect(add0.tokens).toBe(hostEstimateFromCanonicalBytes(Buffer.byteLength(recordBody, "utf8")).tokens);
      }
      expect(skippedBodies.size).toBeGreaterThan(0);
    } finally {
      await session.stop();
    }
  });

  it("malformed intake outcome length/key/order degrades and publishes no settle/add", async () => {
    for (const malformed of ["length", "key", "order"] as const) {
      const root = mkdtempSync(join(tmpdir(), `cc-lhc-est-mal-${malformed}-`));
      const projectsRoot = join(root, "projects");
      const cwd = `/work/est-mal-${malformed}`;
      mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
      const sid = "ffffffff-0000-1111-2222-333333333333";
      const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
      writeFileSync(path, "");

      const lifecycle: LifecycleSignal[] = [];
      const session = startCaptureSession({
        cwd,
        expectedSession: { sessionId: sid, source: "fresh" },
        knownRolloutPath: path,
        prefixBoundary: { kind: "none" },
        noInference: true,
        discoverDeps: { projectsRoot, pollMs: 20 },
        lineageDbPath: join(root, "lineage.sqlite"),
        registryPath: join(root, "reg.sqlite"),
        log: () => {},
        logError: () => {},
        onLifecycle: (signals) => {
          lifecycle.push(...signals);
        },
        createThreadFn: async () => ({
          ok: true,
          value: { threadId: `th_mal_${malformed}`, registryPath: join(root, "reg.sqlite") } as ThreadRef,
        }),
        initSdkFn: () => fakeSdk([], { malformed }),
      });

      try {
        await waitFor(() => session.isCaptureReady(), "ready");
        lifecycle.length = 0;
        appendJsonl(path, userLine(sid, `u-mal-${malformed}`, "open"));
        appendJsonl(
          path,
          completeAssistant(sid, `a-mal-${malformed}`, `req_mal_${malformed}`, "x", {
            input_tokens: 1_000,
            output_tokens: 3,
          }),
        );
        await sleep(500);
        expect(lifecycle.filter((s) => s.kind === "post_measurement_estimate")).toHaveLength(0);
        expect(lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(0);
        expect(session.getCaptureHealth().phase === "degraded" || session.isCaptureReady() === false).toBe(true);
        expect(lifecycle.some((s) => s.kind === "capture_degraded")).toBe(true);
      } finally {
        await session.stop();
      }
    }
  });

  it("successful new events after sampling publish estimate exactly once then settle", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-est-ok-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/est-ok";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "cccccccc-dddd-eeee-ffff-000000000001";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(path, "");

    const lifecycle: LifecycleSignal[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "fresh" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath: join(root, "lineage.sqlite"),
      registryPath: join(root, "reg.sqlite"),
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => {
        lifecycle.push(...signals);
      },
      createThreadFn: async () => ({
        ok: true,
        value: { threadId: "th_ok", registryPath: join(root, "reg.sqlite") } as ThreadRef,
      }),
      initSdkFn: () => fakeSdk([]),
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      lifecycle.length = 0;

      appendJsonl(path, userLine(sid, "u-open", "open turn"));
      await waitFor(() => lifecycle.some((s) => s.kind === "turn_opened"), "turn opened");

      appendJsonl(
        path,
        completeAssistant(sid, "a-ok", "req_ok", "done", {
          input_tokens: 2_000,
          output_tokens: 12,
        }),
      );
      await waitFor(
        () =>
          lifecycle.some((s) => s.kind === "sampling_observed") &&
          lifecycle.some((s) => s.kind === "post_measurement_estimate" && s.mode === "set" && s.tokens === 12) &&
          lifecycle.some((s) => s.kind === "turn_settled"),
        "sampling + set + settle",
      );

      const kinds = lifecycle
        .filter(
          (s) => s.kind === "sampling_observed" || s.kind === "post_measurement_estimate" || s.kind === "turn_settled",
        )
        .map((s) => s.kind);
      const iSample = kinds.indexOf("sampling_observed");
      const iSet = kinds.findIndex((k, i) => k === "post_measurement_estimate" && i > iSample);
      const iSettle = kinds.indexOf("turn_settled");
      expect(iSample).toBeGreaterThanOrEqual(0);
      expect(iSet).toBeGreaterThan(iSample);
      expect(iSettle).toBeGreaterThan(iSet);
      expect(lifecycle.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "set")).toHaveLength(1);
    } finally {
      await session.stop();
    }
  });
});
