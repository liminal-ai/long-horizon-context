/**
 * F2: a rebuilt transcript orphaned by a kill between its write and the switch.
 *
 * The rebuilt session is recorded against its thread as NOT YET ACCEPTED before
 * its file is written, and promoted at the switch. Every reader treats an
 * unaccepted session as the thread's — never as its current session — so a
 * `cc-lhc -c` that picks the orphan as the newest transcript lands on the
 * thread's current session. Orphans from before the record existed are
 * recognized by their rebuild prefix.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Lhc, SessionThreadView, ThreadRef } from "lhc";
import { describe, expect, it, vi } from "vitest";

import { runContextMutation } from "../../src/commands/context-mutation.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { registerRebuiltSessionLineage, reserveRebuiltSessionLineage } from "../../src/commands/rebuild-receipt.js";
import { resolveLaunchSession } from "../../src/intake/launch-session.js";
import { openLaunchThread } from "../../src/intake/launch-thread.js";
import {
  appendThreadSignatures,
  lookupSessionLineage,
  rebuiltSessionRows,
  recordSessionThread,
} from "../../src/intake/lineage-db.js";
import type { PrefixBoundaryVerified } from "../../src/intake/prefix-boundary.js";
import { signaturesForRolloutLine } from "../../src/intake/replay-dedupe.js";
import { startCaptureSession } from "../../src/intake/session.js";
import {
  acceptCurrentSession,
  bindLaunchThread,
  claudeSessionAlias,
  currentSessionAlias,
  recordSwapAcceptance,
  resolveLaunchThread,
  unacceptedSwapArtifacts,
} from "../../src/intake/thread-alias.js";
import {
  identifyUnlinkedRebuild,
  unlinkedRebuildGuidance,
  unlinkedRebuildLaunchGuidance,
} from "../../src/intake/unlinked-rebuild.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import type { RolloutLineItem } from "../../src/rollout/types.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import type { ProbeProcessIdentity } from "../../src/runtime/process-identity.js";
import { threadOwnerPath } from "../../src/runtime/thread-owner.js";
import { executeHandoff, type HandoffPorts } from "../../src/wrapper/handoff.js";
import { runLaunchSweep } from "../../src/wrapper/launch-sweep.js";
import { consumeLegacyHandoffState } from "../../src/wrapper/legacy-handoff-state.js";
import { aliveResult, notFoundResult, selfIdentity, syntheticIdentity } from "../helpers/identity.js";

const actualWriteRebuiltRollout = writeRebuilt.writeRebuiltRollout;

const OLD = "11111111-1111-4111-8111-111111111111";
const CURRENT = "22222222-2222-4222-8222-222222222222";
const ORPHAN = "33333333-3333-4333-8333-333333333333";
const OTHER_CURRENT = "44444444-4444-4444-8444-444444444444";
/** Alder's re-review counterexample, unchanged (ALDER-REREVIEW-043.md). */
const ALDER_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/alder-043-short-tail-orphan.jsonl");
const ALDER_ORPHAN = "11111111-1111-4111-8111-111111111111";
const ALDER_B_SIGNATURES = [
  "7e3af9d1d0129ff782e097d54f659e50c830318997c669c8e72762a7f428a7c4",
  "ba1a1cc30c8df3501d24c76f710ecf0981164d92d8b3e38e7f1d90fd6178ed00",
];
const VERIFIED: PrefixBoundaryVerified = { kind: "verified", lineCount: 2, byteLength: 40, sha256: "cd".repeat(32) };

interface Fixture {
  home: string;
  registryPath: string;
  lineageDbPath: string;
  projectsRoot: string;
  cwd: string;
  projectDir: string;
}

function fixture(label: string): Fixture {
  const home = mkdtempSync(join(tmpdir(), `cc-lhc-f2-${label}-`));
  const projectsRoot = join(home, "projects");
  const cwd = `/work/f2-${label}`;
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  mkdirSync(projectDir, { recursive: true });
  return {
    home,
    registryPath: join(home, "registry.sqlite"),
    lineageDbPath: join(home, "cc-lhc.sqlite"),
    projectsRoot,
    cwd,
    projectDir,
  };
}

function clock(): { nowFn: () => Date } {
  let tick = 0;
  return {
    nowFn: () => {
      tick += 1;
      return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
    },
  };
}

/** A thread whose registry current is CURRENT (moved on from OLD). */
async function seedThread(f: Fixture, threadId: string, first = OLD, current = CURRENT): Promise<void> {
  await bindLaunchThread({
    sessionId: first,
    registryPath: f.registryPath,
    lineageDbPath: f.lineageDbPath,
    createThread: async () => threadId,
  });
  await acceptCurrentSession({ sessionId: current, threadId, registryPath: f.registryPath });
  const c = clock();
  recordSessionThread(f.lineageDbPath, first, threadId, c, { prefix: { kind: "none" } });
  recordSessionThread(f.lineageDbPath, current, threadId, c, { prefix: VERIFIED });
}

function writeTranscript(f: Fixture, sessionId: string, mtimeSec: number): string {
  const path = join(f.projectDir, `${sessionId}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({ type: "user", uuid: `u-${sessionId}`, sessionId, message: { role: "user", content: "hi" } })}\n`,
  );
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

const VIEW: SessionThreadView = {
  threadId: "th_view",
  entries: [
    { role: "user", content: "[context · smooth]\nearlier work summarized", sourceMessages: [] },
    { role: "user", content: "please rename the widget module to gadget", sourceMessages: [] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Renamed widget to gadget across 4 files." }],
      sourceMessages: [],
    },
  ],
} as unknown as SessionThreadView;

/** A rebuilt transcript exactly as Smart Compact writes it, with no record. */
async function writeUnrecordedRebuild(f: Fixture, sessionId: string, view: SessionThreadView = VIEW): Promise<string> {
  const written = await actualWriteRebuiltRollout({
    view,
    cwd: f.cwd,
    newSessionId: sessionId,
    projectsRoot: f.projectsRoot,
    receipt: { text: "[lhc compact:auto] trigger context 508k; rebuilt LHC view 247k (240k target)." },
  });
  return written.rolloutPath;
}

/** The replay signatures capture recorded for the turns the rebuild replays. */
function capturedSignatures(path: string): string[] {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RolloutLineItem);
  return lines.slice(1, -1).flatMap((line, index) => signaturesForRolloutLine(line, index));
}

describe("the rebuilt session is recorded before it is written", () => {
  it("a reservation is unaccepted; the switch promotes it", async () => {
    const f = fixture("promote");
    const reserved = await reserveRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_p",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    expect(reserved.ok).toBe(true);
    expect(lookupSessionLineage(f.lineageDbPath, ORPHAN)).toMatchObject({ threadId: "th_p", accepted: false });
    // The F3 sweep sees it as a rebuilt session.
    expect(rebuiltSessionRows(f.lineageDbPath)).toEqual([
      expect.objectContaining({ sessionId: ORPHAN, threadId: "th_p", accepted: false }),
    ]);

    await registerRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_p",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    expect(lookupSessionLineage(f.lineageDbPath, ORPHAN)).toMatchObject({ accepted: true, prefix: VERIFIED });
  });

  it("writeRebuiltRollout runs the reservation before any byte of the file exists", async () => {
    const f = fixture("hook-order");
    const seen: Array<{ exists: boolean; sessionId: string }> = [];
    const written = await actualWriteRebuiltRollout({
      view: VIEW,
      cwd: f.cwd,
      projectsRoot: f.projectsRoot,
      beforeWrite: async (reservation) => {
        seen.push({ exists: existsSync(reservation.rolloutPath), sessionId: reservation.sessionId });
        expect(reservation.prefixBoundary.lineCount).toBeGreaterThan(0);
      },
    });
    expect(seen).toEqual([{ exists: false, sessionId: written.sessionId }]);
    expect(existsSync(written.rolloutPath)).toBe(true);
  });

  it("a reservation that throws aborts the write", async () => {
    const f = fixture("hook-throw");
    await expect(
      actualWriteRebuiltRollout({
        view: VIEW,
        cwd: f.cwd,
        newSessionId: ORPHAN,
        projectsRoot: f.projectsRoot,
        beforeWrite: async () => {
          throw new Error("killed");
        },
      }),
    ).rejects.toThrow("killed");
    expect(existsSync(join(f.projectDir, `${ORPHAN}.jsonl`))).toBe(false);
  });

  it("Smart Compact records the rebuilt session against its thread, unaccepted, before writing it", async () => {
    const f = fixture("compact");
    const atWrite: Array<{ fileExists: boolean; accepted: boolean | undefined; threadId: string | undefined }> = [];
    const spy = vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async (input) =>
      actualWriteRebuiltRollout({
        ...input,
        projectsRoot: f.projectsRoot,
        beforeWrite: async (reservation) => {
          await input.beforeWrite?.(reservation);
          const entry = lookupSessionLineage(f.lineageDbPath, reservation.sessionId);
          atWrite.push({
            fileExists: existsSync(reservation.rolloutPath),
            accepted: entry?.accepted,
            threadId: entry?.threadId,
          });
        },
      }),
    );
    const sdk = {
      threadView: {
        previewCompact: vi.fn(async () => ({ ok: true, value: { kind: "ok" } })),
        compact: vi.fn(async () => ({
          ok: true,
          value: {
            viewId: "v1",
            tailTokens: 5,
            totalTokens: 9,
            bands: {
              smooth: { entries: 1, tokens: 4 },
              detailed: { entries: 0, tokens: 0 },
              brief: { entries: 0, tokens: 0 },
            },
          },
        })),
        getSessionThreadView: vi.fn(async () => ({ ok: true, value: VIEW })),
      },
    };
    const runtime = {
      stats: { threadId: "th_cm" },
      sdk: sdk as unknown as Lhc,
      threadRef: { threadId: "th_cm", registryPath: f.registryPath } as ThreadRef,
      cwd: f.cwd,
      sourceRolloutPath: undefined,
      sourceSessionId: CURRENT,
      isTurnOpen: () => false,
      isCaptureHealthy: () => true,
      isCaptureReady: () => true,
      capturePhase: "ready",
      lineageDbPath: f.lineageDbPath,
    } as unknown as LhcCommandRuntime;

    try {
      const outcome = await runContextMutation(
        { operation: "auto_compact", profile: "default", lowerBoundTokens: 240_000 },
        runtime,
      );
      expect(outcome.kind).toBe("rebuilt");
      expect(atWrite).toEqual([{ fileExists: false, accepted: false, threadId: "th_cm" }]);
      // Nothing after the write accepts it: only the switch does.
      if (outcome.kind !== "rebuilt") throw new Error("unreachable");
      expect(lookupSessionLineage(f.lineageDbPath, outcome.handoff.rebuilt.sessionId)?.accepted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("a failed handoff leaves the reservation unaccepted; a completed one promotes it at the switch", async () => {
    const f = fixture("handoff");
    const request = (sessionId: string) => ({
      operation: "auto_compact" as const,
      oldSessionId: CURRENT,
      threadId: "th_h",
      rebuilt: {
        sessionId,
        rolloutPath: join(f.projectDir, `${sessionId}.jsonl`),
        lineCount: 3,
        expectedReintakeLines: 3,
        replayedPrefixLines: 2,
        prefixBoundary: VERIFIED,
        totalByteLength: 60,
      },
      receiptLines: [],
      durableReceipt: "[lhc compact:auto] x.",
      metrics: { origin: "auto" as const },
      liveAsyncWork: [],
    });
    const ports = (overrides: Partial<HandoffPorts> = {}): HandoffPorts => ({
      preHandoffStop: () => null,
      spawnCandidate: (sessionId) => ({ sessionId, pid: 4242, child: { write: () => {} } }),
      awaitCandidateViable: async () => ({
        kind: "viable",
        evidence: { processAlive: true, sessionFileWritten: true },
      }),
      discardCandidate: async () => {},
      switchToCandidate: () => ({ switched: true, captureStarted: true }),
      killOldChild: async () => ({ kind: "terminated", pid: 1 }),
      awaitReplacementCaptureReady: async () => "ready",
      reconcileCapture: () => {},
      // The production port's lineage half: promotion at the switch.
      registerSuccessLineage: (handoff) =>
        registerRebuiltSessionLineage({
          newSessionId: handoff.rebuilt.sessionId,
          threadId: handoff.threadId,
          prefixBoundary: handoff.rebuilt.prefixBoundary,
          lineageDbPath: f.lineageDbPath,
        }),
      publishReadyDescriptor: () => true,
      log: () => {},
      warn: () => {},
      ...overrides,
    });

    const failedId = "55555555-5555-4555-8555-555555555555";
    await reserveRebuiltSessionLineage({
      newSessionId: failedId,
      threadId: "th_h",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    const failed = await executeHandoff(
      request(failedId),
      ports({ awaitCandidateViable: async () => ({ kind: "exited", exitCode: 1 }) as never }),
      { replacementAttempts: 1 },
    );
    expect(failed.kind).toBe("replacement_nonviable");
    expect(lookupSessionLineage(f.lineageDbPath, failedId)?.accepted).toBe(false);

    const cancelledId = "66666666-6666-4666-8666-666666666666";
    await reserveRebuiltSessionLineage({
      newSessionId: cancelledId,
      threadId: "th_h",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    const cancelled = await executeHandoff(request(cancelledId), ports({ preHandoffStop: () => "turn opened" }));
    expect(cancelled.kind).toBe("cancelled");
    expect(lookupSessionLineage(f.lineageDbPath, cancelledId)?.accepted).toBe(false);

    await reserveRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_h",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    const done = await executeHandoff(request(ORPHAN), ports());
    expect(done.kind).toBe("success");
    expect(lookupSessionLineage(f.lineageDbPath, ORPHAN)?.accepted).toBe(true);
  });

  it("a one-shot rebuild stays unaccepted until its acceptance is recorded", async () => {
    const f = fixture("one-shot");
    await seedThread(f, "th_os");
    await registerRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_os",
      prefixBoundary: VERIFIED,
      accepted: false,
      lineageDbPath: f.lineageDbPath,
    });
    expect(lookupSessionLineage(f.lineageDbPath, ORPHAN)?.accepted).toBe(false);
    const accepted = await recordSwapAcceptance({
      sessionId: ORPHAN,
      threadId: "th_os",
      registryPath: f.registryPath,
      lineageDbPath: f.lineageDbPath,
    });
    expect(accepted.registryAdvanced).toBe(true);
    expect(lookupSessionLineage(f.lineageDbPath, ORPHAN)?.accepted).toBe(true);
  });
});

describe("no reader treats an unaccepted session as current", () => {
  it("legacy import (thread-alias) makes the last ACCEPTED session current and never aliases the reservation", async () => {
    const f = fixture("import");
    const c = clock();
    // Pre-registry lineage only: the registry has never seen this thread.
    recordSessionThread(f.lineageDbPath, OLD, "th_legacy", c, { prefix: { kind: "none" } });
    recordSessionThread(f.lineageDbPath, CURRENT, "th_legacy", c, { prefix: VERIFIED });
    recordSessionThread(f.lineageDbPath, ORPHAN, "th_legacy", c, { prefix: VERIFIED, accepted: false });

    // Entering through the orphan itself imports the thread from its accepted sessions.
    const threadId = await resolveLaunchThread({
      sessionId: ORPHAN,
      registryPath: f.registryPath,
      lineageDbPath: f.lineageDbPath,
    });
    expect(threadId).toBe("th_legacy");
    expect(await currentSessionAlias("th_legacy", f.registryPath)).toBe(claudeSessionAlias(CURRENT));
    expect(
      await resolveLaunchThread({ sessionId: OLD, registryPath: f.registryPath, lineageDbPath: f.lineageDbPath }),
    ).toBe("th_legacy");
    // Still not an alias: the reservation resolves only through its record.
    const { threads } = await import("lhc");
    const aliased = await threads.resolveAlias({ alias: claudeSessionAlias(ORPHAN), registryPath: f.registryPath });
    expect(aliased.ok).toBe(false);
  });

  it("the discard reader (thread-alias) reports an unaccepted session wherever it sorts, never the current one", async () => {
    const f = fixture("discard");
    const c = clock();
    recordSessionThread(f.lineageDbPath, OLD, "th_d", c, { prefix: { kind: "none" } });
    // Reserved, then the handoff failed and the current session was rebound later.
    recordSessionThread(f.lineageDbPath, ORPHAN, "th_d", c, { prefix: VERIFIED, accepted: false });
    recordSessionThread(f.lineageDbPath, CURRENT, "th_d", c, { prefix: VERIFIED });

    const artifacts = unacceptedSwapArtifacts({
      threadId: "th_d",
      currentSessionId: CURRENT,
      lineageDbPath: f.lineageDbPath,
    });
    expect(artifacts.map((a) => a.sessionId)).toEqual([ORPHAN]);
    // The current session is never an artifact, even if a stray record says unaccepted.
    recordSessionThread(f.lineageDbPath, CURRENT, "th_d", c, { prefix: VERIFIED, accepted: false });
    expect(
      unacceptedSwapArtifacts({ threadId: "th_d", currentSessionId: CURRENT, lineageDbPath: f.lineageDbPath }).map(
        (a) => a.sessionId,
      ),
    ).toEqual([ORPHAN]);
  });

  it("legacy handoff state never claims an unaccepted session as the thread's", async () => {
    const f = fixture("legacy");
    const recovery = join(f.home, "recovery");
    mkdirSync(recovery, { recursive: true });
    const artifact = join(recovery, "handoff-x.json");
    writeFileSync(artifact, JSON.stringify({ rebuiltSessionId: ORPHAN }));
    recordSessionThread(f.lineageDbPath, ORPHAN, "th_l", {}, { prefix: VERIFIED, accepted: false });

    const before = consumeLegacyHandoffState({ home: f.home, lineageDbPath: f.lineageDbPath, threadId: "th_l" });
    expect(before.legacyRecoveryFiles).toBe(0);
    expect(existsSync(artifact)).toBe(true);

    await registerRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_l",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    const after = consumeLegacyHandoffState({ home: f.home, lineageDbPath: f.lineageDbPath, threadId: "th_l" });
    expect(after.legacyRecoveryFiles).toBe(1);
  });
});

describe("cc-lhc -c with the orphan as the newest transcript", () => {
  const now = Date.now() / 1000;

  async function continueLaunch(f: Fixture, createThread: () => Promise<string> = mustNotCreate) {
    const plan = await resolveLaunchSession(["-c"], { cwd: f.cwd, discoverDeps: { projectsRoot: f.projectsRoot } });
    const logs: string[] = [];
    const opened = await openLaunchThread({
      expectedSession: plan.expected,
      registryPath: f.registryPath,
      lineageDbPath: f.lineageDbPath,
      home: f.home,
      createThread,
      log: (m) => logs.push(m),
    });
    return { plan, opened, logs };
  }

  function mustNotCreate(): Promise<string> {
    return Promise.reject(new Error("this launch must not create a thread"));
  }

  it("an unaccepted orphan lands the launch on its thread's current session", async () => {
    const f = fixture("dash-c");
    await seedThread(f, "th_c");
    writeTranscript(f, OLD, now - 600);
    writeTranscript(f, CURRENT, now - 300);
    await reserveRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_c",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    writeTranscript(f, ORPHAN, now - 60);

    const { plan, opened, logs } = await continueLaunch(f);
    try {
      expect(plan.expected).toEqual({ sessionId: ORPHAN, source: "continue_resolved" });
      expect(opened.threadId).toBe("th_c");
      expect(opened.createdAtLaunch).toBe(false);
      expect(opened.correctedFrom).toBe(ORPHAN);
      expect(opened.expectedSession).toEqual({ sessionId: CURRENT, source: "current_alias" });
      expect(opened.discardedSwapArtifacts.map((a) => a.sessionId)).toEqual([ORPHAN]);
      expect(logs.some((m) => m.includes(`landing on its current session ${CURRENT}`))).toBe(true);
      // The orphan never became current.
      expect(await currentSessionAlias("th_c", f.registryPath)).toBe(claudeSessionAlias(CURRENT));
    } finally {
      opened.lease.release();
    }
  });

  it("tolerates an unaccepted record whose file was never written", async () => {
    const f = fixture("no-file");
    await seedThread(f, "th_nf");
    writeTranscript(f, CURRENT, now - 300);
    await reserveRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_nf",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });

    const { opened } = await continueLaunch(f);
    try {
      expect(opened.expectedSession.sessionId).toBe(CURRENT);
      expect(opened.discardedSwapArtifacts.map((a) => a.sessionId)).toEqual([ORPHAN]);
    } finally {
      opened.lease.release();
    }
    // Explicitly asking for the never-written session also lands on the current one.
    const direct = await openLaunchThread({
      expectedSession: { sessionId: ORPHAN, source: "explicit_resume" },
      registryPath: f.registryPath,
      lineageDbPath: f.lineageDbPath,
      home: f.home,
      createThread: mustNotCreate,
    });
    try {
      expect(direct.expectedSession.sessionId).toBe(CURRENT);
    } finally {
      direct.lease.release();
    }
    const log = { info: () => {}, warn: () => {} };
    const swept = await runLaunchSweep({
      home: f.home,
      cwd: f.cwd,
      registryPath: f.registryPath,
      lineageDbPath: f.lineageDbPath,
      projectsRoot: f.projectsRoot,
      log,
    });
    expect(swept?.rebuilds).toMatchObject({ moved: [], failed: [] });
  });

  it("a pre-fix orphan (no record) is never bound to a thread by its content, even a full match", async () => {
    const f = fixture("prefix");
    await seedThread(f, "th_mine");
    writeTranscript(f, CURRENT, now - 300);
    const path = await writeUnrecordedRebuild(f, ORPHAN);
    utimesSync(path, now - 60, now - 60);
    appendThreadSignatures(f.lineageDbPath, "th_mine", capturedSignatures(path));

    const { opened } = await continueLaunch(f, async () => "th_orphan_new");
    try {
      expect(opened.threadId).toBe("th_orphan_new");
      expect(opened.createdAtLaunch).toBe(true);
      expect(opened.expectedSession.sessionId).toBe(ORPHAN);
    } finally {
      opened.lease.release();
    }
    expect(await identifyUnlinkedRebuild({ rolloutPath: path, lineageDbPath: f.lineageDbPath })).toEqual({
      possibleThreadIds: ["th_mine"],
    });
  });

  it("an ordinary unknown session still opens a new thread", async () => {
    const f = fixture("unknown");
    await seedThread(f, "th_known");
    writeTranscript(f, ORPHAN, now - 60);
    const { opened } = await continueLaunch(f, async () => "th_new");
    try {
      expect(opened.threadId).toBe("th_new");
      expect(opened.createdAtLaunch).toBe(true);
      expect(opened.expectedSession.sessionId).toBe(ORPHAN);
    } finally {
      opened.lease.release();
    }
  });

  it("a pre-fix orphan's capture refusal gives the picker and lists matched threads only as possible", async () => {
    const f = fixture("unidentified");
    await seedThread(f, "th_a");
    await seedThread(f, "th_b", "77777777-7777-4777-8777-777777777777", OTHER_CURRENT);
    const path = await writeUnrecordedRebuild(f, ORPHAN);
    utimesSync(path, now - 60, now - 60);
    // Both threads recorded the same replayed turns: no single thread is identified.
    const signatures = capturedSignatures(path);
    appendThreadSignatures(f.lineageDbPath, "th_a", signatures);
    appendThreadSignatures(f.lineageDbPath, "th_b", signatures);

    const { opened } = await continueLaunch(f, async () => "th_orphan_new");
    const errors: string[] = [];
    let session: ReturnType<typeof startCaptureSession> | undefined;
    try {
      expect(opened.createdAtLaunch).toBe(true);
      session = startCaptureSession({
        expectedSession: opened.expectedSession,
        cwd: f.cwd,
        startedAt: new Date(Date.now() - 60_000),
        noInference: true,
        lineageDbPath: f.lineageDbPath,
        registryPath: f.registryPath,
        discoverDeps: { projectsRoot: f.projectsRoot, pollMs: 20 },
        launchThread: { threadId: opened.threadId, createdAtLaunch: true },
        log: () => {},
        logError: (m) => errors.push(m),
      });
      for (let i = 0; i < 100 && !errors.some((m) => m.includes("--resume")); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const guidance = errors.find((m) => m.includes("--resume"));
      expect(guidance).toBeDefined();
      expect(guidance).toContain("run cc-lhc --resume with no id and pick it");
      expect(guidance).toContain("Possible matches (shared text only, unverified)");
      expect(guidance).toContain(`cc-lhc --resume ${CURRENT}`);
      expect(guidance).toContain(`cc-lhc --resume ${OTHER_CURRENT}`);
      expect(errors.join("\n")).not.toContain("/smart-compact");
    } finally {
      await session?.stop();
      opened.lease.release();
    }
  });

  it("Alder's short-tail orphan (2 replayed lines, both common text) is not bound to the thread that holds them", async () => {
    const f = fixture("alder-short-tail");
    const A_FIRST = "55555555-5555-4555-8555-555555555555";
    const A_CURRENT = "66666666-6666-4666-8666-666666666666";
    await seedThread(f, "th_actual_A", A_FIRST, A_CURRENT);
    await seedThread(f, "th_unrelated_B", "77777777-7777-4777-8777-777777777777", OTHER_CURRENT);
    const path = join(f.projectDir, `${ALDER_ORPHAN}.jsonl`);
    writeFileSync(path, readFileSync(ALDER_FIXTURE));
    utimesSync(path, now - 60, now - 60);
    // Alder's lineage: A's bounded window has aged the tail out; B holds exactly the two replayed lines.
    appendThreadSignatures(
      f.lineageDbPath,
      "th_actual_A",
      Array.from({ length: 20 }, (_, n) => `later-A-${n + 1}`),
    );
    appendThreadSignatures(f.lineageDbPath, "th_unrelated_B", ALDER_B_SIGNATURES);

    // B matches 2 of 2: the old rules linked it. It is only a possible match now.
    expect(await identifyUnlinkedRebuild({ rolloutPath: path, lineageDbPath: f.lineageDbPath })).toEqual({
      possibleThreadIds: ["th_unrelated_B"],
    });
    const { opened } = await continueLaunch(f, async () => "th_orphan_new");
    try {
      expect(opened.threadId).toBe("th_orphan_new");
      expect(opened.expectedSession.sessionId).toBe(ALDER_ORPHAN);
    } finally {
      opened.lease.release();
    }

    const guidance = await unlinkedRebuildLaunchGuidance({
      sessionId: ALDER_ORPHAN,
      rolloutPath: path,
      registryPath: f.registryPath,
      lineageDbPath: f.lineageDbPath,
    });
    expect(guidance).toBe(
      `cc-lhc: session ${ALDER_ORPHAN} is a Smart Compact rebuilt transcript from an interrupted compaction that ` +
        "cc-lhc cannot link to a thread; capture is off for it. Continue the conversation it was compacted from: " +
        "run cc-lhc --resume with no id and pick it. " +
        `Possible matches (shared text only, unverified): cc-lhc --resume ${OTHER_CURRENT}`,
    );
  });

  it("launch guidance is only for a rebuilt transcript nothing links; a recorded or ordinary session gets none", async () => {
    const f = fixture("launch-guidance");
    await seedThread(f, "th_known");
    const orphan = await writeUnrecordedRebuild(f, ORPHAN);
    const args = { registryPath: f.registryPath, lineageDbPath: f.lineageDbPath };
    expect(await unlinkedRebuildLaunchGuidance({ ...args, sessionId: ORPHAN, rolloutPath: orphan })).toContain(
      "cannot link to a thread",
    );
    expect(await unlinkedRebuildLaunchGuidance({ ...args, sessionId: ORPHAN, rolloutPath: orphan })).not.toContain(
      "Possible matches",
    );
    // A captured session (the thread's own current one) is not an orphan.
    const current = writeTranscript(f, CURRENT, now - 300);
    expect(await unlinkedRebuildLaunchGuidance({ ...args, sessionId: CURRENT, rolloutPath: current })).toBeNull();
    // An unaccepted reservation resolves through its record, not guidance.
    await reserveRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_known",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    expect(await unlinkedRebuildLaunchGuidance({ ...args, sessionId: ORPHAN, rolloutPath: orphan })).toBeNull();
    // An ordinary unknown session (no rebuild prefix) is not an orphan either.
    const plain = join(f.projectDir, "88888888-8888-4888-8888-888888888888.jsonl");
    writeFileSync(plain, `${JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } })}\n`);
    expect(
      await unlinkedRebuildLaunchGuidance({
        ...args,
        sessionId: "88888888-8888-4888-8888-888888888888",
        rolloutPath: plain,
      }),
    ).toBeNull();
  });

  it("guidance never presents a possible match as the answer", () => {
    const none = unlinkedRebuildGuidance(ORPHAN, []);
    expect(none).toContain("run cc-lhc --resume with no id and pick it");
    expect(none).not.toContain("Possible matches");
    expect(none).not.toContain("/smart-compact");
    const one = unlinkedRebuildGuidance(ORPHAN, [CURRENT]);
    expect(one).toContain(`Possible matches (shared text only, unverified): cc-lhc --resume ${CURRENT}`);
    expect(one).not.toContain("Continue the conversation with:");
  });
});

describe("F3 launch sweep and an unaccepted reservation", () => {
  const DEAD = syntheticIdentity(4_200_002);
  const LIVE = syntheticIdentity(4_200_001);
  const probe: ProbeProcessIdentity = (pid) => (pid === LIVE.pid ? aliveResult(LIVE) : notFoundResult(pid));

  function writeLease(f: Fixture, threadId: string, pid: typeof LIVE): void {
    mkdirSync(join(f.home, "owners"), { recursive: true });
    writeFileSync(
      threadOwnerPath(threadId, f.home),
      `${JSON.stringify({ version: 1, threadId, token: "tok", processIdentity: pid, acquiredAt: "x" })}\n`,
    );
  }

  async function sweepOnce(f: Fixture) {
    return runLaunchSweep({
      home: f.home,
      cwd: f.cwd,
      registryPath: f.registryPath,
      lineageDbPath: f.lineageDbPath,
      projectsRoot: f.projectsRoot,
      readIdentity: probe,
      log: { info: () => {}, warn: () => {} },
    });
  }

  it("moves an old reservation whose handoff is dead, keeps one whose handoff owner is live", async () => {
    const hourAgo = Date.now() / 1000 - 3600;
    const dead = fixture("sweep-dead");
    await seedThread(dead, "th_dead");
    await reserveRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_dead",
      prefixBoundary: VERIFIED,
      lineageDbPath: dead.lineageDbPath,
    });
    writeTranscript(dead, ORPHAN, hourAgo);
    writeLease(dead, "th_dead", DEAD);
    const deadSweep = await sweepOnce(dead);
    expect(deadSweep?.rebuilds).toMatchObject({ moved: [expect.objectContaining({ sessionId: ORPHAN })] });

    const live = fixture("sweep-live");
    await seedThread(live, "th_live");
    await reserveRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_live",
      prefixBoundary: VERIFIED,
      lineageDbPath: live.lineageDbPath,
    });
    writeTranscript(live, ORPHAN, hourAgo);
    writeLease(live, "th_live", LIVE);
    const liveSweep = await sweepOnce(live);
    expect(liveSweep?.rebuilds).toMatchObject({
      moved: [],
      kept: [{ sessionId: ORPHAN, reason: "thread owner live" }],
    });
    expect(existsSync(join(live.projectDir, `${ORPHAN}.jsonl`))).toBe(true);
  });

  it("a recovery launch of the crashed thread moves its own abandoned rebuild aside (real launch order)", async () => {
    const hourAgo = Date.now() / 1000 - 3600;
    const f = fixture("sweep-own");
    await seedThread(f, "th_crashed");
    await seedThread(f, "th_busy", "77777777-7777-4777-8777-777777777777", OTHER_CURRENT);
    // The crashed wrapper's handoff reserved and wrote a rebuild an hour ago, then died holding its lease.
    await reserveRebuiltSessionLineage({
      newSessionId: ORPHAN,
      threadId: "th_crashed",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    writeTranscript(f, ORPHAN, hourAgo);
    writeTranscript(f, CURRENT, Date.now() / 1000 - 300);
    writeLease(f, "th_crashed", DEAD);
    // Another thread's old rebuild whose owner is live stays protected.
    const busyOrphan = "99999999-9999-4999-8999-999999999999";
    await reserveRebuiltSessionLineage({
      newSessionId: busyOrphan,
      threadId: "th_busy",
      prefixBoundary: VERIFIED,
      lineageDbPath: f.lineageDbPath,
    });
    writeTranscript(f, busyOrphan, hourAgo);
    writeLease(f, "th_busy", LIVE);

    // The launch order in run(): take the thread's lease (reclaiming the dead one), then sweep.
    const plan = await resolveLaunchSession(["--resume", CURRENT], {
      cwd: f.cwd,
      discoverDeps: { projectsRoot: f.projectsRoot },
    });
    const opened = await openLaunchThread({
      expectedSession: plan.expected,
      registryPath: f.registryPath,
      lineageDbPath: f.lineageDbPath,
      home: f.home,
      createThread: () => Promise.reject(new Error("must not create")),
      log: () => {},
    });
    try {
      expect(opened.threadId).toBe("th_crashed");
      const liveProbe: ProbeProcessIdentity = (pid) =>
        pid === LIVE.pid ? aliveResult(LIVE) : pid === process.pid ? aliveResult(selfIdentity()) : notFoundResult(pid);
      const swept = await runLaunchSweep({
        home: f.home,
        cwd: f.cwd,
        registryPath: f.registryPath,
        lineageDbPath: f.lineageDbPath,
        projectsRoot: f.projectsRoot,
        ownThreadId: opened.threadId,
        readIdentity: liveProbe,
        log: { info: () => {}, warn: () => {} },
      });
      expect(swept?.rebuilds).toMatchObject({
        moved: [expect.objectContaining({ sessionId: ORPHAN })],
        kept: expect.arrayContaining([{ sessionId: busyOrphan, reason: "thread owner live" }]),
      });
      expect(existsSync(join(f.projectDir, `${ORPHAN}.jsonl`))).toBe(false);
      expect(existsSync(join(f.projectDir, `${busyOrphan}.jsonl`))).toBe(true);
    } finally {
      opened.lease.release();
    }
  });
});
