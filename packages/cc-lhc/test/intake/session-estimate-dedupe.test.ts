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

function fakeSdk(intake: MessageEventInput[]): Lhc {
  return {
    intakeStream: {
      messageEvents: async (_ref: ThreadRef, events: MessageEventInput[]) => {
        intake.push(...events);
        return {
          ok: true as const,
          value: { events: events.map(() => ({ outcome: "recorded" as const })) },
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
                value: { events: events.map(() => ({ outcome: "recorded" as const })) },
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
