/**
 * Correction 5: content-verifiable rebuilt-prefix fence across process exit.
 * Adversarial coverage — corrupt each producer path; do not only assert happy path.
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Lhc, MessageEventInput, ThreadRef } from "lhc";
import { describe, expect, it } from "vitest";

import { registerRebuiltSessionLineage } from "../../src/commands/rebuild-receipt.js";
import {
  lookupSessionLineage,
  recordSessionThread,
} from "../../src/intake/lineage-db.js";
import type { LifecycleSignal } from "../../src/observation/types.js";
import { startCaptureSession } from "../../src/intake/session.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import { writeRebuiltRollout } from "../../src/rollout/write-rebuilt.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, label: string, capMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

const BAND_MARKER = "[context · smooth]\nNOVEL-BAND-SUMMARY-must-not-enter-canonical";
const TAIL_USER = "tail-user-live-prompt";
const TAIL_ASSISTANT = "tail-assistant-live-text";
const LIVE_APPEND = "post-resume-live-only";

function hermeticSession(
  opts: {
    root: string;
    cwd: string;
    projectsRoot: string;
    lineageDbPath: string;
    registryPath: string;
    threadId: string;
    sessionId: string;
    rolloutPath: string;
    intake: MessageEventInput[];
    lifecycle?: LifecycleSignal[];
  },
) {
  return startCaptureSession({
    cwd: opts.cwd,
    expectedSession: { sessionId: opts.sessionId, source: "explicit_resume" },
    knownRolloutPath: opts.rolloutPath,
    noInference: true,
    discoverDeps: { projectsRoot: opts.projectsRoot, pollMs: 20 },
    lineageDbPath: opts.lineageDbPath,
    registryPath: opts.registryPath,
    log: () => {},
    logError: () => {},
    onLifecycle: (signals) => {
      opts.lifecycle?.push(...signals);
    },
    launchThread: { threadId: opts.threadId, createdAtLaunch: false },
    initSdkFn: () => ({}) as Lhc,
    flushBatchFn: async (_sdk, _ref, _items, events) => {
      opts.intake.push(...events);
    },
  });
}

async function buildBandedRebuilt(root: string, sessionId: string) {
  const projectsRoot = join(root, "projects");
  const cwd = "/work/prefix-resume";
  mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
  const rebuilt = await writeRebuiltRollout({
    view: {
      threadId: "th_prefix",
      entries: [
        { role: "user", content: BAND_MARKER, sourceMessages: [] },
        {
          role: "assistant",
          content: [{ type: "text", text: "band-adjacent-projection-text" }],
          sourceMessages: [],
        },
        { role: "user", content: TAIL_USER, sourceMessages: [] },
        {
          role: "assistant",
          content: [{ type: "text", text: TAIL_ASSISTANT }],
          sourceMessages: [],
        },
      ],
    },
    cwd,
    projectsRoot,
    newSessionId: sessionId,
    receipt: { text: "[lhc compact:manual] rebuilt LHC view 1.4k (240k target)." },
  });
  return { rebuilt, projectsRoot, cwd };
}

describe("content-verifiable rebuilt prefix fence", () => {
  it("exact verified prefix succeeds; live suffix captured; band never enters canonical", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-ok-"));
    const sessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const { rebuilt, projectsRoot, cwd } = await buildBandedRebuilt(root, sessionId);
    expect(rebuilt.prefixBoundary.kind).toBe("verified");
    expect(rebuilt.replayedPrefixLines).toBe(4);
    expect(rebuilt.lineCount).toBe(5);

    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const threadId = "th_prefix_resume";
    const reg = await registerRebuiltSessionLineage({
      newSessionId: rebuilt.sessionId,
      threadId,
      prefixBoundary: rebuilt.prefixBoundary,
      lineageDbPath,
    });
    expect(reg.ok).toBe(true);
    const stored = lookupSessionLineage(lineageDbPath, rebuilt.sessionId);
    expect(stored?.prefix).toMatchObject({
      kind: "verified",
      lineCount: 4,
      byteLength: rebuilt.prefixBoundary.byteLength,
      sha256: rebuilt.prefixBoundary.sha256,
    });

    // Ordinary re-bind must not clear verified fence.
    recordSessionThread(lineageDbPath, rebuilt.sessionId, threadId);
    expect(lookupSessionLineage(lineageDbPath, rebuilt.sessionId)?.prefix.kind).toBe("verified");

    const intake: MessageEventInput[] = [];
    const lifecycle: LifecycleSignal[] = [];
    const session = hermeticSession({
      root,
      cwd,
      projectsRoot,
      lineageDbPath,
      registryPath,
      threadId,
      sessionId: rebuilt.sessionId,
      rolloutPath: rebuilt.rolloutPath,
      intake,
      lifecycle,
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready after verified prefix");
      await waitFor(() => session.stats.replayedPrefixLines === 4, "prefix tallied");
      // No runtime lifecycle from prefix before session_bound.
      const beforeBound = lifecycle.slice(
        0,
        lifecycle.findIndex((s) => s.kind === "session_bound") + 1,
      );
      expect(beforeBound.some((s) => s.kind === "session_bound")).toBe(true);
      expect(beforeBound.some((s) => s.kind === "turn_opened")).toBe(false);
      expect(beforeBound.some((s) => s.kind === "turn_settled")).toBe(false);
      expect(beforeBound.some((s) => s.kind === "sampling_observed")).toBe(false);
      expect(beforeBound.some((s) => s.kind === "native_compact_observed")).toBe(false);

      const serialized = JSON.stringify(intake);
      expect(serialized).not.toContain("NOVEL-BAND-SUMMARY");
      expect(serialized).not.toContain("band-adjacent-projection-text");
      expect(serialized).not.toContain(TAIL_USER);
      expect(serialized).not.toContain(TAIL_ASSISTANT);

      appendFileSync(
        rebuilt.rolloutPath,
        `${JSON.stringify({
          type: "user",
          uuid: "live-after-resume",
          sessionId: rebuilt.sessionId,
          message: { role: "user", content: LIVE_APPEND },
        })}\n`,
      );
      await waitFor(() => JSON.stringify(intake).includes(LIVE_APPEND), "live suffix");
      expect(JSON.stringify(intake)).not.toContain("NOVEL-BAND-SUMMARY");
    } finally {
      await session.stop();
    }
  });

  it("stored boundary larger than initial complete content refuses readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-short-"));
    const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const { rebuilt, projectsRoot, cwd } = await buildBandedRebuilt(root, sessionId);
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const threadId = "th_short";

    // Truncate file so it is shorter than the verified byte boundary.
    const original = readFileSync(rebuilt.rolloutPath);
    writeFileSync(rebuilt.rolloutPath, original.subarray(0, Math.max(1, rebuilt.prefixBoundary.byteLength - 10)));

    await registerRebuiltSessionLineage({
      newSessionId: rebuilt.sessionId,
      threadId,
      prefixBoundary: rebuilt.prefixBoundary,
      lineageDbPath,
    });

    const intake: MessageEventInput[] = [];
    const session = hermeticSession({
      root,
      cwd,
      projectsRoot,
      lineageDbPath,
      registryPath,
      threadId,
      sessionId: rebuilt.sessionId,
      rolloutPath: rebuilt.rolloutPath,
      intake,
    });

    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "degraded short file");
      expect(session.isCaptureReady()).toBe(false);
      expect(session.getCaptureHealth().reasons.some((r) => r.startsWith("prefix_boundary"))).toBe(
        true,
      );

      // Append live after failure — must NOT be consumed as prefix (no skip mode).
      appendFileSync(
        rebuilt.rolloutPath,
        `${JSON.stringify({
          type: "user",
          uuid: "after-fail",
          sessionId: rebuilt.sessionId,
          message: { role: "user", content: "must-not-be-prefix-skipped" },
        })}\n`,
      );
      await sleep(200);
      // Intake halted/not ready: either empty or if anything landed it is live not prefix-skip.
      expect(session.stats.replayedPrefixLines).toBe(0);
      expect(session.isCaptureReady()).toBe(false);
    } finally {
      await session.stop();
    }
  });

  it("prefix bytes modified refuse readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-mod-"));
    const sessionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const { rebuilt, projectsRoot, cwd } = await buildBandedRebuilt(root, sessionId);
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const threadId = "th_mod";

    // Flip one byte inside the verified prefix region.
    const buf = Buffer.from(readFileSync(rebuilt.rolloutPath));
    const flipAt = Math.min(20, rebuilt.prefixBoundary.byteLength - 1);
    buf[flipAt] = (buf[flipAt]! ^ 0xff) & 0xff;
    writeFileSync(rebuilt.rolloutPath, buf);

    await registerRebuiltSessionLineage({
      newSessionId: rebuilt.sessionId,
      threadId,
      prefixBoundary: rebuilt.prefixBoundary,
      lineageDbPath,
    });

    const intake: MessageEventInput[] = [];
    const session = hermeticSession({
      root,
      cwd,
      projectsRoot,
      lineageDbPath,
      registryPath,
      threadId,
      sessionId: rebuilt.sessionId,
      rolloutPath: rebuilt.rolloutPath,
      intake,
    });
    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "digest mismatch");
      expect(session.isCaptureReady()).toBe(false);
      expect(JSON.stringify(intake)).not.toContain("NOVEL-BAND-SUMMARY");
    } finally {
      await session.stop();
    }
  });

  it("reordered prefix lines refuse readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-reorder-"));
    const sessionId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const { rebuilt, projectsRoot, cwd } = await buildBandedRebuilt(root, sessionId);
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const threadId = "th_reorder";

    const content = readFileSync(rebuilt.rolloutPath, "utf8");
    const all = content.trimEnd().split("\n");
    // Swap first two complete lines (still same count/bytes length roughly but digest differs).
    if (all.length >= 2) {
      const tmp = all[0]!;
      all[0] = all[1]!;
      all[1] = tmp;
    }
    writeFileSync(rebuilt.rolloutPath, `${all.join("\n")}\n`);

    await registerRebuiltSessionLineage({
      newSessionId: rebuilt.sessionId,
      threadId,
      prefixBoundary: rebuilt.prefixBoundary,
      lineageDbPath,
    });

    const session = hermeticSession({
      root,
      cwd,
      projectsRoot,
      lineageDbPath,
      registryPath,
      threadId,
      sessionId: rebuilt.sessionId,
      rolloutPath: rebuilt.rolloutPath,
      intake: [],
    });
    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "reorder");
      expect(session.isCaptureReady()).toBe(false);
    } finally {
      await session.stop();
    }
  });

  it("unknown provenance with served band + live-looking suffix: zero intake, never ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-unknown-band-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/unknown-band";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sessionId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sessionId}.jsonl`);
    // Served band plus a live-looking suffix — both must stay out of the record.
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "b1", sessionId, message: { role: "user", content: BAND_MARKER } })}\n` +
        `${JSON.stringify({ type: "user", uuid: "live", sessionId, message: { role: "user", content: "live-unknown-suffix" } })}\n`,
    );
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const threadId = "th_unk_band";
    recordSessionThread(lineageDbPath, sessionId, threadId, {}, { prefix: { kind: "unknown" } });

    const intake: MessageEventInput[] = [];
    const session = hermeticSession({
      root,
      cwd,
      projectsRoot,
      lineageDbPath,
      registryPath,
      threadId,
      sessionId,
      rolloutPath: path,
      intake,
    });
    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "unknown degrades");
      expect(session.isCaptureReady()).toBe(false);
      expect(session.isCaptureHealthy()).toBe(false);
      expect(session.getCaptureHealth().reasons).toContain("prefix_boundary:unknown_provenance");
      expect(session.stats.replayedPrefixLines).toBe(0);
      expect(session.stats.eventsSent).toBe(0);
      expect(intake).toHaveLength(0);
      expect(JSON.stringify(intake)).not.toContain("NOVEL-BAND-SUMMARY");
      expect(JSON.stringify(intake)).not.toContain("live-unknown-suffix");
    } finally {
      await session.stop();
    }
  });

  it("lineage read failure on banded rollout: zero intake, never ready", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-fail-band-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/lineage-fail-band";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sessionId = "abababab-abab-abab-abab-abababababab";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "b", sessionId, message: { role: "user", content: BAND_MARKER } })}\n` +
        `${JSON.stringify({ type: "user", uuid: "l", sessionId, message: { role: "user", content: "lure-live" } })}\n`,
    );
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const intake: MessageEventInput[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId, source: "explicit_resume" },
      knownRolloutPath: path,
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      lineageDeps: {
        withDb: () => {
          throw new Error("injected lineage read failure");
        },
      },
      log: () => {},
      logError: () => {},
      launchThread: { threadId: "th_lf", createdAtLaunch: false },
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async (_s, _t, _i, events) => {
        intake.push(...events);
      },
    });
    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "lineage fail degrades");
      expect(session.isCaptureReady()).toBe(false);
      expect(session.getCaptureHealth().reasons).toContain("prefix_boundary:unknown_provenance");
      expect(intake).toHaveLength(0);
      expect(JSON.stringify(intake)).not.toContain("NOVEL-BAND-SUMMARY");
      expect(JSON.stringify(intake)).not.toContain("lure-live");
    } finally {
      await session.stop();
    }
  });

  it("explicit resume with no lineage row refuses (does not invent known-none)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-resume-no-row-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/resume-no-row";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sessionId = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u", sessionId, message: { role: "user", content: "resume-no-row" } })}\n`,
    );
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const intake: MessageEventInput[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId, source: "explicit_resume" },
      knownRolloutPath: path,
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      log: () => {},
      logError: () => {},
      launchThread: { threadId: "th_nr", createdAtLaunch: false },
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async (_s, _t, _i, events) => {
        intake.push(...events);
      },
    });
    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "no-row degrades");
      expect(session.isCaptureReady()).toBe(false);
      expect(session.getCaptureHealth().reasons).toContain("prefix_boundary:unknown_provenance");
      expect(intake).toHaveLength(0);
    } finally {
      await session.stop();
    }
  });

  it("deterministic fresh launch establishes known-none and can capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-fresh-none-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/fresh-none";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sessionId = "efefefef-efef-efef-efef-efefefefefef";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sessionId}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "f1", sessionId, message: { role: "user", content: "fresh-ok" } })}\n`,
    );
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const intake: MessageEventInput[] = [];
    const session = startCaptureSession({
      cwd,
      expectedSession: { sessionId, source: "fresh" },
      knownRolloutPath: path,
      noInference: true,
      discoverDeps: { projectsRoot, pollMs: 20 },
      lineageDbPath,
      registryPath,
      log: () => {},
      logError: () => {},
      launchThread: { threadId: "th_fresh", createdAtLaunch: true },
      initSdkFn: () => ({}) as Lhc,
      flushBatchFn: async (_s, _t, _i, events) => {
        intake.push(...events);
      },
    });
    try {
      await waitFor(() => session.isCaptureReady(), "fresh ready");
      await waitFor(() => JSON.stringify(intake).includes("fresh-ok"), "fresh intake");
      expect(lookupSessionLineage(lineageDbPath, sessionId)?.prefix.kind).toBe("none");
    } finally {
      await session.stop();
    }
  });

  it("unknown provenance on a normal-looking native rollout still refuses (no band is not proof)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-unknown-native-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/unknown-native";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sessionId = "10101010-1010-1010-1010-101010101010";
    const path = join(projectsRoot, encodeProjectPath(cwd), `${sessionId}.jsonl`);
    // Ordinary-looking user/assistant rollout — still unknown, still refuse.
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "u1", sessionId, message: { role: "user", content: "hello native-looking" } })}\n` +
        `${JSON.stringify({
          type: "assistant",
          uuid: "a1",
          sessionId,
          message: {
            role: "assistant",
            id: "msg_n",
            model: "m",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "hi there" }],
          },
        })}\n`,
    );
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const threadId = "th_unk_native";
    recordSessionThread(lineageDbPath, sessionId, threadId, {}, { prefix: { kind: "unknown" } });

    const intake: MessageEventInput[] = [];
    const session = hermeticSession({
      root,
      cwd,
      projectsRoot,
      lineageDbPath,
      registryPath,
      threadId,
      sessionId,
      rolloutPath: path,
      intake,
    });
    try {
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "unknown refuses native-looking");
      expect(session.isCaptureReady()).toBe(false);
      expect(session.getCaptureHealth().reasons).toContain("prefix_boundary:unknown_provenance");
      expect(intake).toHaveLength(0);
      expect(JSON.stringify(intake)).not.toContain("hello native-looking");
      expect(JSON.stringify(intake)).not.toContain("hi there");
    } finally {
      await session.stop();
    }
  });

  it("post-ready truncate/rewrite degrades and cannot pollute canonical intake", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-shrink-"));
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { rebuilt, projectsRoot, cwd } = await buildBandedRebuilt(root, sessionId);
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    const threadId = "th_shrink";
    await registerRebuiltSessionLineage({
      newSessionId: rebuilt.sessionId,
      threadId,
      prefixBoundary: rebuilt.prefixBoundary,
      lineageDbPath,
    });

    const intake: MessageEventInput[] = [];
    const session = hermeticSession({
      root,
      cwd,
      projectsRoot,
      lineageDbPath,
      registryPath,
      threadId,
      sessionId: rebuilt.sessionId,
      rolloutPath: rebuilt.rolloutPath,
      intake,
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      // Truncate file below current watcher offset (past verified prefix).
      writeFileSync(rebuilt.rolloutPath, "");
      await waitFor(() => session.getCaptureHealth().phase === "degraded", "shrink degrade");
      expect(session.isCaptureReady()).toBe(false);

      // Rewrite with band projection and a "live" lure — must not enter intake.
      writeFileSync(
        rebuilt.rolloutPath,
        `${JSON.stringify({ type: "user", uuid: "pollute", sessionId, message: { role: "user", content: BAND_MARKER } })}\n` +
          `${JSON.stringify({ type: "user", uuid: "lure", sessionId, message: { role: "user", content: "post-shrink-lure" } })}\n`,
      );
      await sleep(300);
      const serialized = JSON.stringify(intake);
      expect(serialized).not.toContain("NOVEL-BAND-SUMMARY");
      expect(serialized).not.toContain("post-shrink-lure");
    } finally {
      await session.stop();
    }
  });

  it("prefix lifecycle is suppressed; first live suffix sees pristine turn fold", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-prefix-life-"));
    const projectsRoot = join(root, "projects");
    const cwd = "/work/life";
    mkdirSync(join(projectsRoot, encodeProjectPath(cwd)), { recursive: true });
    const sessionId = "12121212-1212-1212-1212-121212121212";
    // Prefix contains shapes that would emit every runtime lifecycle kind if live.
    const rebuilt = await writeRebuiltRollout({
      view: {
        threadId: "th_life",
        entries: [
          { role: "user", content: "prefix-user-open", sourceMessages: [] },
          {
            role: "assistant",
            content: [{ type: "text", text: "prefix-assistant-close" }],
            sourceMessages: [],
          },
        ],
      },
      cwd,
      projectsRoot,
      newSessionId: sessionId,
      receipt: { text: "[lhc compact:manual] rebuilt LHC view 1.4k (240k target)." },
    });
    const lineageDbPath = join(root, "cc-lhc.sqlite");
    const registryPath = join(root, "registry.sqlite");
    await registerRebuiltSessionLineage({
      newSessionId: sessionId,
      threadId: "th_life",
      prefixBoundary: rebuilt.prefixBoundary,
      lineageDbPath,
    });

    const lifecycle: LifecycleSignal[] = [];
    const intake: MessageEventInput[] = [];
    const session = hermeticSession({
      root,
      cwd,
      projectsRoot,
      lineageDbPath,
      registryPath,
      threadId: "th_life",
      sessionId,
      rolloutPath: rebuilt.rolloutPath,
      intake,
      lifecycle,
    });

    try {
      await waitFor(() => session.isCaptureReady(), "ready");
      const boundIdx = lifecycle.findIndex((s) => s.kind === "session_bound");
      expect(boundIdx).toBeGreaterThanOrEqual(0);
      const before = lifecycle.slice(0, boundIdx);
      for (const kind of [
        "turn_opened",
        "turn_settled",
        "sampling_observed",
        "native_compact_observed",
      ] as const) {
        expect(before.some((s) => s.kind === kind)).toBe(false);
      }
      // Live fold starts closed; isTurnOpen false until a live open edge.
      expect(session.isTurnOpen()).toBe(false);

      appendFileSync(
        rebuilt.rolloutPath,
        `${JSON.stringify({
          type: "user",
          uuid: "live-open",
          sessionId,
          message: { role: "user", content: "live-open-prompt" },
        })}\n`,
      );
      await waitFor(() => session.isTurnOpen() || JSON.stringify(intake).includes("live-open-prompt"), "live open");
      // After genuine suffix user line, turn may open.
      await waitFor(() => lifecycle.some((s) => s.kind === "turn_opened"), "live turn_opened");
      const afterBound = lifecycle.slice(boundIdx + 1);
      expect(afterBound.some((s) => s.kind === "turn_opened")).toBe(true);
    } finally {
      await session.stop();
    }
  });
});
