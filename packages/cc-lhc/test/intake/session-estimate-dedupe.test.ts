/**
 * LIM-64: post-measurement estimate must commit only after replay dedupe and
 * successful intake. Direct observeRolloutLine tests are insufficient — this
 * drives real startCaptureSession with replay signatures and a lifecycle sink.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens, type Lhc, type MessageEventInput, TOKEN_ESTIMATOR_ID, type ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";

import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { decideGovernor } from "../../src/governor/decide.js";
import { applyGovernorLifecycleBatch, createGovernorRuntimeState } from "../../src/governor/observe-state.js";
import type { ResolvedContextPolicy } from "../../src/governor/types.js";
import { loadThreadSignatures, openLineageDatabase, recordSessionThread } from "../../src/intake/lineage-db.js";
import { signaturesForRolloutLine } from "../../src/intake/replay-dedupe.js";
import { startCaptureSession } from "../../src/intake/session.js";
import {
  HOST_CANONICAL_PAYLOAD_BYTE_ESTIMATE_SOURCE,
  pendingPromptEstimate,
  preLaunchEstimate,
  PROVIDER_OUTPUT_ESTIMATE_SOURCE,
  USER_PROMPT_ESTIMATE_SOURCE,
} from "../../src/observation/estimate.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";

function armedPolicy(over: Partial<ResolvedContextPolicy["policy"]> = {}): ResolvedContextPolicy {
  const policy = { ...BUILTIN_CONTEXT_POLICY, ...over };
  const sources = Object.fromEntries(
    Object.keys(policy).map((k) => [k, "builtin"]),
  ) as ResolvedContextPolicy["sources"];
  return { policy, sources, fallbacks: [] };
}

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
      launchThread: { threadId: threadId, createdAtLaunch: true },
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
      launchThread: { threadId: threadId, createdAtLaunch: false },
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
      launchThread: { threadId: "th_fail", createdAtLaunch: true },
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
      launchThread: { threadId: "th_batch", createdAtLaunch: true },
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
      launchThread: { threadId: "th_mixed", createdAtLaunch: true },
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
      // Only the recorded user line (LHC estimateTokens), not the skipped 8k tool.
      expect(adds).toHaveLength(1);
      const add0 = adds[0]!;
      expect(add0.kind).toBe("post_measurement_estimate");
      if (add0.kind === "post_measurement_estimate") {
        expect(add0.tokens).toBe(estimateTokens(recordBody));
        expect(add0.source).toBe(USER_PROMPT_ESTIMATE_SOURCE);
        expect(add0.source).toContain(TOKEN_ESTIMATOR_ID);
      }
      expect(skippedBodies.size).toBeGreaterThan(0);
    } finally {
      await session.stop();
    }
  }, 15_000);

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
        launchThread: { threadId: `th_mal_${malformed}`, createdAtLaunch: true },
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
      launchThread: { threadId: "th_ok", createdAtLaunch: true },
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

  it("multi-turn catch-up batch: one intake, line-ordered lifecycle, matching settle sampling", async () => {
    // Two complete user/assistant turns delivered as the watcher's initial
    // catch-up batch. Lifecycle must stay model-turn ordered (not all sampling
    // first / all settles later), and each settled observe must bind the
    // matching samplingId + provider total for that turn.
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-est-multiturn-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/est-multiturn";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "11111111-2222-3333-4444-555555555555";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);

    // Turn 1 provider total = 100_000 (below upper 200k); turn 2 = 250_000 (above).
    // Distinct output tokens so mode:set values also prove per-turn identity.
    const turn1Usage = {
      input_tokens: 100_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 11,
    };
    const turn2Usage = {
      input_tokens: 250_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 22,
    };
    const lines: RolloutLineItem[] = [
      userLine(sid, "u-mt-1", "first user turn"),
      completeAssistant(sid, "a-mt-1", "req_mt_1", "first reply", turn1Usage),
      userLine(sid, "u-mt-2", "second user turn"),
      completeAssistant(sid, "a-mt-2", "req_mt_2", "second reply", turn2Usage),
    ];
    writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));

    const intake: MessageEventInput[] = [];
    let intakeCalls = 0;
    const lifecycle: LifecycleSignal[] = [];
    // Fold governor live as capture publishes so settle observations see
    // line-ordered state (not a post-hoc batch of the full stream).
    const resolved = armedPolicy({ upperBoundTokens: 200_000, lowerBoundTokens: 50_000 });
    let gov = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const settledObserves: Array<{
      samplingId: string | null;
      providerContextTotal: number | null;
      wouldMutate: boolean;
      decision: string;
      inputEpoch: number;
      inputEpochAtTurnOpen: number;
    }> = [];

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
        // Mirror wrapper: user input epoch bumps are external; for pure
        // capture-path proof we only fold lifecycle signals themselves.
        // turn_opened snapshots inputEpochAtTurnOpen from currentInputEpoch —
        // if the flattened bug existed, settle(1) would hold sampling of turn 2.
        const applied = applyGovernorLifecycleBatch(gov, signals, resolved);
        gov = applied.state;
        for (const o of applied.observes) {
          if (o.observePhase === "settled_seam") {
            settledObserves.push({
              samplingId: o.samplingId,
              providerContextTotal: o.providerContextTotal,
              wouldMutate: o.wouldMutate,
              decision: o.decision,
              inputEpoch: o.inputEpoch,
              inputEpochAtTurnOpen: o.inputEpochAtTurnOpen,
            });
          }
        }
      },
      launchThread: { threadId: "th_multiturn", createdAtLaunch: true },
      initSdkFn: () =>
        fakeSdk(intake, {
          onCall: () => {
            intakeCalls += 1;
          },
        }),
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      await waitFor(
        () => lifecycle.filter((s) => s.kind === "turn_settled").length >= 2,
        "both turns settled",
      );
      // Allow the serial batch queue to finish any trailing publish.
      await sleep(100);

      expect(intakeCalls).toBe(1);

      // Lifecycle order is model-turn order, not all-sampling-then-all-settles.
      const pressureKinds = lifecycle
        .filter(
          (s) =>
            s.kind === "turn_opened" ||
            s.kind === "sampling_observed" ||
            s.kind === "post_measurement_estimate" ||
            s.kind === "turn_settled",
        )
        .map((s) => {
          if (s.kind === "sampling_observed") return `sample:${s.samplingId}`;
          if (s.kind === "post_measurement_estimate") return `est:${s.mode ?? "set"}:${s.tokens}`;
          return s.kind;
        });

      const iOpen1 = pressureKinds.indexOf("turn_opened");
      const iSample1 = pressureKinds.indexOf("sample:req:req_mt_1");
      const iSet1 = pressureKinds.indexOf("est:set:11");
      const iSettle1 = pressureKinds.indexOf("turn_settled");
      const iOpen2 = pressureKinds.indexOf("turn_opened", iSettle1 + 1);
      const iSample2 = pressureKinds.indexOf("sample:req:req_mt_2");
      const iSet2 = pressureKinds.indexOf("est:set:22");
      const iSettle2 = pressureKinds.indexOf("turn_settled", iSettle1 + 1);

      expect(iOpen1).toBeGreaterThanOrEqual(0);
      expect(iSample1).toBeGreaterThan(iOpen1);
      expect(iSet1).toBeGreaterThan(iSample1);
      expect(iSettle1).toBeGreaterThan(iSet1);
      expect(iOpen2).toBeGreaterThan(iSettle1);
      expect(iSample2).toBeGreaterThan(iOpen2);
      expect(iSet2).toBeGreaterThan(iSample2);
      expect(iSettle2).toBeGreaterThan(iSet2);

      // Explicit anti-flatten: second sampling must not precede first settle.
      expect(iSample2).toBeGreaterThan(iSettle1);

      // Two distinct completes → two mode:set, two settles.
      expect(lifecycle.filter((s) => s.kind === "turn_settled")).toHaveLength(2);
      expect(lifecycle.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "set")).toHaveLength(2);

      expect(settledObserves).toHaveLength(2);
      // First settle binds turn-1 sampling + provider total (not turn 2's 250k).
      expect(settledObserves[0]!.samplingId).toBe("req:req_mt_1");
      expect(settledObserves[0]!.providerContextTotal).toBe(100_000);
      expect(settledObserves[0]!.wouldMutate).toBe(false);
      expect(settledObserves[0]!.decision).not.toBe("would_compact");

      // Second settle binds turn-2 sampling; only this turn crosses trigger.
      expect(settledObserves[1]!.samplingId).toBe("req:req_mt_2");
      expect(settledObserves[1]!.providerContextTotal).toBe(250_000);
      expect(settledObserves[1]!.decision).toBe("would_compact");
      expect(settledObserves[1]!.wouldMutate).toBe(true);

      // Input epoch / turn-open state must not collapse the two turns into one
      // open window: each settle sees matching open/current epochs (no mid-turn
      // epoch change), and two independent open→settle cycles occurred.
      expect(settledObserves[0]!.inputEpoch).toBe(settledObserves[0]!.inputEpochAtTurnOpen);
      expect(settledObserves[1]!.inputEpoch).toBe(settledObserves[1]!.inputEpochAtTurnOpen);
      // After two complete open→settle cycles, governor must be closed again.
      expect(gov.turnOpen).toBe(false);
      expect(gov.latestSamplingId).toBe("req:req_mt_2");
      expect(gov.settleSequence).toBe(2);
    } finally {
      await session.stop();
    }
  });

  it("mixed replay/new catch-up: only the new turn arms settle with its sampling", async () => {
    // Phase 1 records one complete turn. Phase 2 re-tails that history plus a
    // novel second turn in one catch-up batch. Replayed lines must not arm
    // set/settle; the new turn's sampling/usage is the one used at its settle.
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-est-mixed-replay-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/est-mixed-replay";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(path, "");

    const lineageDbPath = join(root, "lineage.sqlite");
    const registryPath = join(root, "reg.sqlite");
    const threadId = "th_mixed_replay";
    openLineageDatabase(lineageDbPath);
    recordSessionThread(lineageDbPath, sid, threadId, {}, { prefix: { kind: "none" } });

    const oldUsage = {
      input_tokens: 80_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 5,
    };
    const newUsage = {
      input_tokens: 300_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 33,
    };

    // Phase 1: capture the first complete turn so signatures exist.
    {
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
        launchThread: { threadId: threadId, createdAtLaunch: true },
        initSdkFn: () => fakeSdk([]),
      });
      try {
        await waitFor(() => session1.isCaptureReady(), "phase1 ready");
        appendJsonl(path, userLine(sid, "u-old", "old user"));
        appendJsonl(path, completeAssistant(sid, "a-old", "req_old", "old reply", oldUsage));
        await waitFor(() => lifecycle1.some((s) => s.kind === "turn_settled"), "phase1 settled");
      } finally {
        await session1.stop();
      }
    }

    expect(loadThreadSignatures(lineageDbPath, threadId).length).toBeGreaterThan(0);

    // Append novel second turn before re-open so the initial catch-up batch
    // contains old (replay) + new (record) in one delivery.
    appendJsonl(path, userLine(sid, "u-new", "new user after replay"));
    appendJsonl(path, completeAssistant(sid, "a-new", "req_new", "new reply", newUsage));

    let intakeCalls = 0;
    const lifecycle2: LifecycleSignal[] = [];
    const resolved = armedPolicy({ upperBoundTokens: 200_000, lowerBoundTokens: 50_000 });
    let gov = createGovernorRuntimeState({
      captureGeneration: 1,
    });
    const settledObserves: Array<{
      samplingId: string | null;
      providerContextTotal: number | null;
      wouldMutate: boolean;
      decision: string;
    }> = [];

    const session2 = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "explicit_resume" },
      knownRolloutPath: path,
      prefixBoundary: { kind: "none" },
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      log: () => {},
      logError: () => {},
      onLifecycle: (signals) => {
        lifecycle2.push(...signals);
        const applied = applyGovernorLifecycleBatch(gov, signals, resolved);
        gov = applied.state;
        for (const o of applied.observes) {
          if (o.observePhase === "settled_seam") {
            settledObserves.push({
              samplingId: o.samplingId,
              providerContextTotal: o.providerContextTotal,
              wouldMutate: o.wouldMutate,
              decision: o.decision,
            });
          }
        }
      },
      launchThread: { threadId: threadId, createdAtLaunch: false },
      initSdkFn: () =>
        fakeSdk([], {
          onCall: () => {
            intakeCalls += 1;
          },
        }),
    });

    try {
      await waitFor(() => session2.isCaptureReady(), "phase2 ready");
      await waitFor(
        () => lifecycle2.some((s) => s.kind === "turn_settled"),
        "new turn settled",
      );
      await sleep(100);

      // One whole-batch intake for the novel events in catch-up (replay-filtered).
      expect(intakeCalls).toBe(1);
      expect(session2.stats.skippedReplay).toBeGreaterThan(0);

      // Replayed old turn must not arm mode:set or a settle with old sampling.
      // Only the novel turn settles.
      expect(lifecycle2.filter((s) => s.kind === "turn_settled")).toHaveLength(1);
      const sets = lifecycle2.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "set");
      expect(sets).toHaveLength(1);
      expect(sets[0]!.kind).toBe("post_measurement_estimate");
      if (sets[0]!.kind === "post_measurement_estimate") {
        expect(sets[0]!.tokens).toBe(33);
      }

      // Sampling order: if old sampling republishes (sampling dedupe may suppress),
      // it must not interleave ahead of the new turn's settle incorrectly — the
      // settle must bind the new sampling only.
      const samples = lifecycle2.filter((s) => s.kind === "sampling_observed");
      const newSample = samples.find((s) => s.kind === "sampling_observed" && s.samplingId === "req:req_new");
      expect(newSample).toBeDefined();

      const iNewSample = lifecycle2.findIndex(
        (s) => s.kind === "sampling_observed" && s.samplingId === "req:req_new",
      );
      const iSet = lifecycle2.findIndex(
        (s) => s.kind === "post_measurement_estimate" && s.mode === "set" && s.tokens === 33,
      );
      const iSettle = lifecycle2.findIndex((s) => s.kind === "turn_settled");
      expect(iNewSample).toBeGreaterThanOrEqual(0);
      expect(iSet).toBeGreaterThan(iNewSample);
      expect(iSettle).toBeGreaterThan(iSet);

      // No old-turn mode:set (output 5) and no settle for old sampling.
      expect(
        lifecycle2.some(
          (s) => s.kind === "post_measurement_estimate" && s.mode === "set" && s.tokens === 5,
        ),
      ).toBe(false);

      expect(settledObserves).toHaveLength(1);
      expect(settledObserves[0]!.samplingId).toBe("req:req_new");
      expect(settledObserves[0]!.providerContextTotal).toBe(300_000);
      expect(settledObserves[0]!.decision).toBe("would_compact");
      expect(settledObserves[0]!.wouldMutate).toBe(true);
      // Replayed lines cannot arm a settle: only one settled observe.
    } finally {
      await session2.stop();
    }
  });

  it("live intake: 164208 + exact user 66025 + API-error zeros preserve pressure for next prelaunch", async () => {
    const prompt = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "burnin-defect-001-prompt.txt"),
      "utf8",
    );
    expect(Buffer.byteLength(prompt, "utf8")).toBe(104_263);
    expect(estimateTokens(prompt)).toBe(66_025);

    const root = mkdtempSync(join(tmpdir(), "cc-lhc-est-burnin-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/est-burnin";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sid = "22222222-3333-4444-5555-666666666666";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sid}.jsonl`);
    writeFileSync(path, "");
    const lineageDbPath = join(root, "lineage.sqlite");
    const registryPath = join(root, "reg.sqlite");
    const threadId = "th_burnin_defect001";
    openLineageDatabase(lineageDbPath);
    recordSessionThread(lineageDbPath, sid, threadId, {}, { prefix: { kind: "none" } });

    const resolved = armedPolicy({
      autoCompact: true,
      lowerBoundTokens: 100_000,
      upperBoundTokens: 200_000,
      minRunwayTokens: 50_000,
      profile: "balanced",
    });
    let gov = createGovernorRuntimeState({ captureGeneration: 1 });
    const lifecycle: LifecycleSignal[] = [];
    const observes: Array<{
      observePhase: string;
      decision: string;
      providerContextTotal: number | null;
      pressure: number;
    }> = [];

    const session = startCaptureSession({
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
        lifecycle.push(...signals);
        const applied = applyGovernorLifecycleBatch(gov, signals, resolved);
        gov = applied.state;
        for (const o of applied.observes) {
          observes.push({
            observePhase: o.observePhase,
            decision: o.decision,
            providerContextTotal: o.providerContextTotal,
            pressure: o.pressure.nextRequestPressureTokens,
          });
        }
      },
      launchThread: { threadId, createdAtLaunch: true },
      initSdkFn: () => fakeSdk([]),
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      appendJsonl(
        path,
        completeAssistant(sid, "a-prior", "req_prior", "ok", {
          input_tokens: 164_208,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        }),
      );
      await waitFor(
        () =>
          lifecycle.some((s) => s.kind === "sampling_observed" && s.samplingId === "req:req_prior") &&
          lifecycle.some(
            (s) => s.kind === "post_measurement_estimate" && s.mode === "set" && s.source === PROVIDER_OUTPUT_ESTIMATE_SOURCE,
          ),
        "prior sampling applied",
      );
      appendJsonl(path, userLine(sid, "u-burnin", prompt));
      await waitFor(
        () =>
          lifecycle.some(
            (s) =>
              s.kind === "post_measurement_estimate" &&
              s.mode === "add" &&
              s.tokens === 66_025 &&
              s.source === USER_PROMPT_ESTIMATE_SOURCE,
          ),
        "accepted user growth",
        15_000,
      );
      appendJsonl(path, {
        type: "assistant",
        uuid: "api-err",
        sessionId: sid,
        error: "invalid_request",
        isApiErrorMessage: true,
        message: {
          role: "assistant",
          id: "msg_api_err",
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "Prompt is too long" }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      await waitFor(() => lifecycle.some((s) => s.kind === "turn_settled"), "api-error settle", 15_000);

      expect(gov.latestProviderContext?.total).toBe(164_208);
      expect(gov.postMeasurementEstimate.tokens).toBe(66_025);
      expect(gov.postMeasurementEstimate.source).toBe(USER_PROMPT_ESTIMATE_SOURCE);
      const iFail = lifecycle.findIndex(
        (s) => s.kind === "sampling_observed" && s.samplingId !== "req:req_prior",
      );
      expect(iFail).toBeGreaterThan(0);
      expect(
        lifecycle.slice(iFail).some((s) => s.kind === "post_measurement_estimate" && s.mode === "set"),
      ).toBe(false);
      expect(lifecycle.some((s) => s.kind === "sampling_observed" && s.samplingId === "req:req_prior")).toBe(true);
      expect(
        lifecycle.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "add" && s.tokens === 66_025),
      ).toHaveLength(1);

      const settled = observes.filter((o) => o.observePhase === "settled_seam");
      expect(settled.length).toBeGreaterThanOrEqual(1);
      const lastSettled = settled.at(-1)!;
      expect(lastSettled.providerContextTotal).toBe(164_208);
      expect(lastSettled.pressure).toBe(230_233);
      expect(lastSettled.decision).toBe("would_compact");
      expect(observes.every((o) => o.providerContextTotal !== 0 && o.pressure !== 0)).toBe(true);

      const nextPrelaunch = decideGovernor({
        policy: resolved.policy,
        turnOpen: false,
        operationInFlight: false,
        providerContext: gov.latestProviderContext,
        providerContextFreshness: "last_known",
        postMeasurementEstimate: preLaunchEstimate(gov.postMeasurementEstimate, "hi"),
      });
      expect(nextPrelaunch.pressure.nextRequestPressureTokens).toBeGreaterThanOrEqual(200_000);
      expect(nextPrelaunch.pressure.nextRequestPressureTokens).toBe(
        164_208 + 66_025 + pendingPromptEstimate("hi").tokens,
      );
      expect(nextPrelaunch.kind).toBe("would_compact");
    } finally {
      await session.stop();
    }

    const lifecycle2: LifecycleSignal[] = [];
    const session2 = startCaptureSession({
      cwd,
      expectedSession: { sessionId: sid, source: "explicit_resume" },
      knownRolloutPath: path,
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
      launchThread: { threadId, createdAtLaunch: false },
      initSdkFn: () => fakeSdk([]),
    });
    try {
      await waitFor(() => session2.isCaptureReady(), "replay ready");
      expect(session2.stats.skippedReplay).toBeGreaterThan(0);
      expect(
        lifecycle2.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "add" && s.tokens === 66_025),
      ).toHaveLength(0);
      expect(lifecycle2.filter((s) => s.kind === "post_measurement_estimate" && s.mode === "add")).toHaveLength(0);
    } finally {
      await session2.stop();
    }
  }, 30_000);
});
