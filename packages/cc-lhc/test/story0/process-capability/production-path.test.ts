/**
 * Story 0 E2: drive the production killOldChild/terminateChild closure through
 * exported run() with a real node-pty old child and replacement — the same
 * auto-handoff rig, without stubbing HandoffPorts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawn as realSpawnPty } from "@lydell/node-pty";
import type { Lhc } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureSession, CaptureSessionDeps } from "../../../src/intake/session.js";
import type { LifecycleSignal } from "../../../src/observation/types.js";
import * as writeRebuilt from "../../../src/rollout/write-rebuilt.js";
import { createNativeIdentityProbe } from "../../../src/runtime/native-identity.js";
import type { ProcessIdentity } from "../../../src/runtime/process-identity.js";
import { emptyCaptureStats } from "../../../src/stats.js";
import type { HandoffResult } from "../../../src/wrapper/handoff.js";
import { run } from "../../../src/wrapper/run.js";
import type { WrapperLog } from "../../../src/wrapper/wrapper-log.js";
import {
  createTerminalObserver,
  fileExists,
  guardedStop,
  identitiesEqual,
  identitySafeSignal,
  type Proof,
  processIdentityJson,
  proof,
  provePosixOutputIdentity,
  readAffiliation,
  receiptPath,
  sleep,
  terminalEventId,
  waitFor,
  writeReceipt,
} from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

const mocks = vi.hoisted(() => ({
  captureFactory: null as ((opts: CaptureSessionDeps) => CaptureSession) | null,
  registerLineage: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
}));

vi.mock("../../../src/intake/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/intake/session.js")>();
  return {
    ...actual,
    startCaptureSession: (opts: CaptureSessionDeps = {}) => {
      if (mocks.captureFactory !== null) return mocks.captureFactory(opts);
      return actual.startCaptureSession(opts);
    },
  };
});

vi.mock("../../../src/commands/rebuild-receipt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/commands/rebuild-receipt.js")>();
  return {
    ...actual,
    registerRebuiltSessionLineage: (...args: unknown[]) =>
      (mocks.registerLineage as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

const REBUILT_ID = "12345678-1234-1234-1234-123456789abc";
const probe = createNativeIdentityProbe({ env: {} });
const requireAddon = process.env.CC_LHC_NATIVE_REQUIRE_ADDON === "1";
const selfProbe = probe(process.pid);

function sdkForCapture() {
  return {
    drainSettled: async () => {},
    threadView: {
      status: vi.fn(async () => ({
        ok: true,
        value: {
          tailTokens: 10,
          threshold: 100,
          visibility: { zoneTokens: 0, maxTokens: 1000 },
          derivation: { pending: 0, failed: 0 },
        },
      })),
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
      prune: vi.fn(),
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_auto", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
    intakeStream: { messageEvents: async () => ({ ok: true, value: { events: [] } }) },
  };
}

function scriptedCaptureSession(
  _deps: CaptureSessionDeps,
  sdk: unknown,
  sessionId: string,
  rolloutPath: string,
  generation: number,
): CaptureSession {
  const stats = { ...emptyCaptureStats(), threadId: "th_auto" };
  return {
    stats,
    getCommandContext: () => ({
      stats,
      sdk: sdk as Lhc,
      threadRef: { threadId: "th_auto", registryPath: "/tmp/reg.sqlite" },
      captureDegraded: false,
      captureGeneration: generation,
      capturePhase: "ready" as const,
    }),
    getRolloutInfo: () => ({ path: rolloutPath, sessionId }),
    isTurnOpen: () => false,
    isCaptureHealthy: () => true,
    isCaptureReady: () => true,
    getCaptureHealth: () => ({
      generation,
      phase: "ready" as const,
      reasons: [],
      reasonCounts: {},
      durableLineOffset: 0,
    }),
    getCaptureGeneration: () => generation,
    getLiveAsyncWork: () => [],
    stop: vi.fn(async () => {}),
  } as unknown as CaptureSession;
}

function afterStatus(result: ReturnType<typeof probe> | undefined): string {
  if (result === undefined) return "missing";
  return result.ok ? "ok" : result.code;
}

function fakeStream(): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & NodeJS.WriteStream;
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
  Object.defineProperty(stream, "columns", { value: 80, configurable: true });
  Object.defineProperty(stream, "rows", { value: 24, configurable: true });
  return stream;
}

const POLICY = {
  policy: {
    lowerBoundTokens: 1_000,
    upperBoundTokens: 5_000,
    profile: "default",
    pruneEnabled: false,
    pruneThresholdTokens: null,
    pruneTargetTokens: null,
    minRunwayTokens: 100,
  },
  sources: Object.fromEntries(
    [
      "lowerBoundTokens",
      "upperBoundTokens",
      "profile",
      "pruneEnabled",
      "pruneThresholdTokens",
      "pruneTargetTokens",
      "minRunwayTokens",
    ].map((k) => [k, "session"]),
  ) as never,
  fallbacks: [],
};

const BOUND_SIGNALS: LifecycleSignal[] = [{ kind: "session_bound", sessionId: "old-session" }];
const TRIGGER_SIGNALS: LifecycleSignal[] = [
  { kind: "turn_opened", reason: "user_prompt" },
  {
    kind: "sampling_observed",
    samplingId: "req:r1",
    providerUsage: { input_tokens: 2, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 3_000 },
  },
  { kind: "turn_settled", reason: "end_turn" },
];

describe.skipIf(!selfProbe.ok && !requireAddon)("Story 0 E2 production terminateChild via run()", () => {
  const savedHome = process.env.CC_LHC_HOME;
  const temps: string[] = [];
  const leftover: ProcessIdentity[] = [];

  beforeEach(() => {
    mocks.registerLineage.mockClear();
    mocks.captureFactory = null;
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-story0-home-"));
    temps.push(home);
    process.env.CC_LHC_HOME = home;
  });

  afterEach(async () => {
    for (const identity of leftover.splice(0)) {
      await identitySafeSignal(identity, probe, "kill");
    }
    vi.restoreAllMocks();
    mocks.captureFactory = null;
    if (savedHome === undefined) delete process.env.CC_LHC_HOME;
    else process.env.CC_LHC_HOME = savedHome;
    for (const d of temps.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("enters run() killOldChild/terminateChild against a real PTY old child", async () => {
    const facts: Record<string, unknown> = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    };
    let stage = "addon";
    let assembled = false;
    const writeFailureReceipt = (cause: unknown): void => {
      writeReceipt(receiptPath(), {
        schemaVersion: 4,
        experiment: "story0-e2-process-capability",
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        stage,
        harnessError: cause instanceof Error ? cause.message : String(cause),
        facts,
      });
    };

    try {
      if (!selfProbe.ok) {
        throw new Error(`CC_LHC_NATIVE_REQUIRE_ADDON=1 but native identity is unavailable: ${selfProbe.message}`);
      }

      stage = "control_dir";
      const controlDir = mkdtempSync(join(tmpdir(), "cc-lhc-story0-e2-"));
      temps.push(controlDir);
      const replacementManifestPath = join(controlDir, "replacement.json");
      const candidates = [
        { id: "attached", launch: "attached", outputPath: join(controlDir, "attached.output") },
        {
          id: "detached_stdio_ignore",
          launch: "detached_stdio_ignore",
          outputPath: join(controlDir, "detached_stdio_ignore.output"),
        },
        {
          id: "detached_stdio_pipe",
          launch: "detached_stdio_pipe",
          outputPath: join(controlDir, "detached_stdio_pipe.output"),
        },
        {
          id: "orphaned_intermediate",
          launch: "orphaned_intermediate",
          outputPath: join(controlDir, "orphaned_intermediate.output"),
        },
      ];
      for (const c of candidates) writeFileSync(c.outputPath, "");
      writeFileSync(
        join(controlDir, "plan.json"),
        `${JSON.stringify({
          workerPath: join(here, "worker.mjs"),
          orphanLauncherPath: join(here, "orphan-launcher.mjs"),
          lifetimeMs: 60_000,
          candidates,
        })}\n`,
      );

      const sdk = sdkForCapture();
      const captureCalls: CaptureSessionDeps[] = [];
      let lifecycleSink: ((signals: readonly LifecycleSignal[]) => void) | undefined;
      const rolloutDir = mkdtempSync(join(tmpdir(), "cc-lhc-story0-rollout-"));
      temps.push(rolloutDir);
      const rebuiltPath = join(rolloutDir, `${REBUILT_ID}.jsonl`);
      const rebuiltContent = '{"line":1}\n{"line":2}\n{"line":3}\n';
      vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async () => {
        writeFileSync(rebuiltPath, rebuiltContent);
        return {
          sessionId: REBUILT_ID,
          rolloutPath: rebuiltPath,
          lineCount: 3,
          expectedReintakeLines: 3,
          replayedPrefixLines: 2,
          prefixBoundary: { kind: "verified" as const, lineCount: 2, byteLength: 40, sha256: "aa".repeat(32) },
          totalByteLength: Buffer.byteLength(rebuiltContent),
        };
      });
      mocks.captureFactory = (opts) => {
        captureCalls.push(opts);
        const generation = captureCalls.length;
        const isRebuilt = opts.knownRolloutPath !== undefined;
        if (!isRebuilt && opts.onLifecycle !== undefined) lifecycleSink = opts.onLifecycle;
        return scriptedCaptureSession(
          opts,
          sdk,
          isRebuilt ? REBUILT_ID : "old-session",
          isRebuilt ? opts.knownRolloutPath! : "/tmp/old-session.jsonl",
          generation,
        );
      };

      const logLines: string[] = [];
      const wrapperLog: WrapperLog = {
        path: join(controlDir, "wrapper.log"),
        info: (message) => {
          logLines.push(message);
        },
        warn: (message) => {
          logLines.push(message);
        },
        warningCount: () => 0,
      };

      const spawnedPids: number[] = [];
      const results: HandoffResult[] = [];
      const stdin = fakeStream();
      const stdout = fakeStream();
      const stderr = fakeStream();

      const runPromise = run(["--effort", "medium"], {
        claudeBin: process.execPath,
        spawnPty: (_file, _args, opts) => {
          const index = spawnedPids.length;
          const script =
            index === 0
              ? [join(here, "old-child.mjs"), controlDir]
              : [join(here, "replacement.mjs"), replacementManifestPath];
          const pty = realSpawnPty(process.execPath, script, { ...opts, cwd: controlDir });
          spawnedPids.push(pty.pid);
          return pty;
        },
        stdin,
        stdout: stdout as never,
        stderr: stderr as never,
        noInference: true,
        resolvedContextPolicy: POLICY as never,
        governorReceiptDbPath: join(controlDir, "governor.sqlite"),
        probeProcessIdentity: probe,
        wrapperLog,
        forceWrapperExit: () => {},
        onHandoffResult: (result) => {
          results.push(result);
        },
        handoffTimeouts: {
          sigtermGraceMs: 500,
          sigkillWaitMs: 1_000,
          captureReadyTimeoutMs: 2_000,
          childLivenessTimeoutMs: 5_000,
          childStableWindowMs: 100,
        },
      });

      stage = "spawn_old_child";
      await waitFor(() => lifecycleSink !== undefined, "capture lifecycle sink");
      await waitFor(() => spawnedPids.length === 1, "first real PTY child");
      const ptyPid = spawnedPids[0]!;
      facts.ptyPid = ptyPid;
      const manifestPath = join(controlDir, "manifest.json");
      await waitFor(() => fileExists(manifestPath), "old-child manifest");
      stage = "manifest";
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        oldChildPid: number;
        processes: Array<{ id: string; launch: string; pid: number | null; intermediatePid: number | null }>;
      };
      facts.oldChildPid = manifest.oldChildPid;
      if (!Number.isSafeInteger(manifest.oldChildPid) || manifest.oldChildPid <= 0) {
        throw new Error(`manifest.oldChildPid is not a live pid: ${String(manifest.oldChildPid)}`);
      }

      const before: Record<string, ProcessIdentity | null> = {};
      const affiliationBefore: Record<string, ReturnType<typeof readAffiliation> | null> = {};
      for (const row of manifest.processes) {
        const live = row.pid === null ? null : probe(row.pid);
        before[row.id] = live?.ok ? live.identity : null;
        affiliationBefore[row.id] = live?.ok ? readAffiliation(live.identity.pid) : null;
        if (before[row.id]) leftover.push(before[row.id]!);
        if (row.intermediatePid !== null) {
          const inter = probe(row.intermediatePid);
          if (inter.ok) leftover.push(inter.identity);
        }
      }
      const oldLive = probe(manifest.oldChildPid);
      facts.ptyPidProbe = probe(ptyPid).ok ? "ok" : "not_ok";
      if (!oldLive.ok) {
        throw new Error(
          `old-child identity from manifest.oldChildPid=${manifest.oldChildPid} unavailable (${oldLive.code}); ptyPid=${ptyPid}`,
        );
      }
      leftover.push(oldLive.identity);
      const oldAff = readAffiliation(manifest.oldChildPid);
      facts.oldChildAffiliation = oldAff;
      const detachedBefore = before.detached_stdio_ignore;
      const detachedAff = detachedBefore ? readAffiliation(detachedBefore.pid) : null;
      facts.detachedAffiliation = detachedAff;

      const outputIdentity =
        process.platform === "win32"
          ? { kind: "unproven" as const, stableAcrossAppend: null, reuseDiscriminated: null }
          : provePosixOutputIdentity(controlDir);

      stage = "handoff";
      lifecycleSink!(BOUND_SIGNALS);
      lifecycleSink!(TRIGGER_SIGNALS);

      await waitFor(() => results.length === 1, "handoff result", 15_000);
      const result = results[0]!;
      expect(result.kind).toBe("success");
      if (result.kind !== "success") throw new Error(`expected success, got ${result.kind}`);
      expect(result.oldChildCleanup.kind).toBe("terminated");
      expect(logLines.some((line) => line.includes("requested child termination"))).toBe(true);
      facts.handoffKind = result.kind;
      facts.oldChildCleanup = result.oldChildCleanup;
      facts.terminateChildLog = logLines.filter((l) => l.includes("termination"));

      await sleep(200);
      const after: Record<string, ReturnType<typeof probe>> = {};
      for (const row of manifest.processes) {
        after[row.id] = row.pid === null ? { ok: false, code: "not_found", message: "no pid" } : probe(row.pid);
      }
      const oldChildAfter = probe(manifest.oldChildPid);
      const oldChildGone = !oldChildAfter.ok && oldChildAfter.code === "not_found";
      facts.oldChildAfter = oldChildGone ? "not_found" : oldChildAfter.ok ? "ok" : oldChildAfter.code;

      stage = "replacement_identity";
      await waitFor(() => {
        if (!fileExists(replacementManifestPath)) return false;
        try {
          const parsed = JSON.parse(readFileSync(replacementManifestPath, "utf8")) as { replacementPid?: unknown };
          return Number.isSafeInteger(parsed.replacementPid) && (parsed.replacementPid as number) > 0;
        } catch {
          return false;
        }
      }, "replacement pid manifest");
      const replacementManifest = JSON.parse(readFileSync(replacementManifestPath, "utf8")) as {
        replacementPid: number;
      };
      facts.replacementPid = replacementManifest.replacementPid;
      facts.replacementPtyPid = spawnedPids[1] ?? null;
      if (!Number.isSafeInteger(replacementManifest.replacementPid) || replacementManifest.replacementPid <= 0) {
        throw new Error(
          `replacementPid is not a live pid: ${String(replacementManifest.replacementPid)}; replacementPtyPid=${String(spawnedPids[1])}`,
        );
      }
      const replacementLive = probe(replacementManifest.replacementPid);
      if (!replacementLive.ok) {
        throw new Error(
          `replacement identity from replacementPid=${replacementManifest.replacementPid} unavailable (${replacementLive.code}); replacementPtyPid=${String(spawnedPids[1])}`,
        );
      }
      leftover.push(replacementLive.identity);
      const replacementIdentity = replacementLive.identity;

      const attachedDead = after.attached !== undefined && !after.attached.ok && after.attached.code === "not_found";
      const detached = before.detached_stdio_ignore;
      const detachedLive =
        detached !== undefined &&
        detached !== null &&
        after.detached_stdio_ignore?.ok === true &&
        identitiesEqual(after.detached_stdio_ignore.identity, detached);

      const proofs: Proof[] = [
        proof("native_process_identity", "proved", "killOldChild used the injected native probe"),
        proof(
          "production_termination_path",
          "proved",
          `run() killOldChild → terminateChild; logs=${logLines.filter((l) => l.includes("child termination")).join(" | ")}; cleanup=${result.oldChildCleanup.kind}`,
        ),
        proof(
          "attached_in_production_termination_set",
          attachedDead && oldChildGone ? "proved" : "candidate_failed",
          attachedDead && oldChildGone
            ? `attached worker and manifest old child (${manifest.oldChildPid}) not_found after production terminateChild of ptyPid=${ptyPid}`
            : `attachedDead=${String(attachedDead)} oldChildGone=${String(oldChildGone)} ptyPid=${ptyPid} oldChildPid=${manifest.oldChildPid}`,
        ),
        proof(
          "survives_production_old_child_termination",
          detachedLive ? "proved" : "candidate_failed",
          detachedLive
            ? "detached_stdio_ignore kept pid+bootId+starttime after production terminateChild"
            : `detached after=${after.detached_stdio_ignore?.ok ? "ok" : after.detached_stdio_ignore?.code}`,
        ),
        proof(
          "result_lifetime_d12",
          "unproved",
          "Immediate scratch-file survival cannot prove a Claude-owned result path or carryoverRetentionMs; the CC-LHC-owned artifact requirement is not eliminated.",
        ),
      ];
      if (process.platform === "win32") {
        proofs.push(
          proof(
            "output_identity_d7",
            "unproved",
            "No authoritative Windows file-id surface in this harness; Node stat is not D-7 proof.",
          ),
        );
      } else {
        const d7ok = outputIdentity.stableAcrossAppend === true && outputIdentity.reuseDiscriminated === true;
        proofs.push(
          proof(
            "output_identity_d7",
            d7ok ? "proved" : "candidate_failed",
            `posix_dev_ino stableAcrossAppend=${String(outputIdentity.stableAcrossAppend)} reuseDiscriminated=${String(outputIdentity.reuseDiscriminated)}`,
          ),
        );
      }

      const detachedSource = detachedAff?.source;
      const sessionSourcesOk =
        (oldAff.source === "linux_proc_stat" || oldAff.source === "darwin_python_getsid") &&
        (detachedSource === "linux_proc_stat" || detachedSource === "darwin_python_getsid");
      const ownSession =
        oldAff.session !== null && detachedAff?.session !== null && detachedAff?.session !== oldAff.session;
      proofs.push(
        proof(
          "posix_detached_own_session",
          process.platform === "win32" ? "unproved" : sessionSourcesOk && ownSession ? "proved" : "candidate_failed",
          process.platform === "win32"
            ? "no POSIX session axis"
            : `old source=${oldAff.source} session=${String(oldAff.session)} raw=${String(oldAff.raw)}; detached source=${String(detachedAff?.source)} session=${String(detachedAff?.session)} raw=${String(detachedAff?.raw)}`,
        ),
      );

      if (detachedLive && detached) {
        const mutated: ProcessIdentity = { ...detached, starttime: detached.starttime === "0" ? "1" : "0" };
        const mismatch = guardedStop(detached.pid, mutated, probe);
        const mismatchOk =
          mismatch.disposition === "refused" && mismatch.signaled === false && mismatch.liveAfter.ok === true;
        proofs.push(
          proof(
            "guarded_stop_mismatch",
            mismatchOk ? "proved" : "candidate_failed",
            `disposition=${mismatch.disposition} signaled=${String(mismatch.signaled)}`,
          ),
        );
        expect(mismatch.signaled).toBe(false);

        const matched = guardedStop(detached.pid, detached, probe);
        const observer = createTerminalObserver();
        const eventId = terminalEventId(detached);
        let previous = matched.liveAfter.ok ? matched.liveAfter : probe(detached.pid);
        // liveAtDecision was ok; feed from a synthetic ok if the immediate after-probe already moved.
        if (!previous.ok) previous = { ok: true, identity: detached };
        let pollsFed = 0;
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          await sleep(50);
          const current = probe(detached.pid);
          pollsFed += 1;
          observer.observe(eventId, previous, current);
          previous = current;
          if (!current.ok && current.code === "not_found") break;
        }
        for (let i = 0; i < 5; i += 1) {
          await sleep(50);
          const current = probe(detached.pid);
          pollsFed += 1;
          observer.observe(eventId, previous, current);
          previous = current;
        }
        const emissions = observer.emissionCount(eventId);
        proofs.push(
          proof(
            "guarded_stop_match",
            matched.signaled && !previous.ok && previous.code === "not_found" ? "proved" : "candidate_failed",
            `signaled=${String(matched.signaled)} after=${previous.ok ? "ok" : previous.code}`,
          ),
        );
        proofs.push(
          proof(
            "single_terminal_observation",
            emissions === 1 ? "proved" : "candidate_failed",
            `emissions=${emissions} pollsFed=${pollsFed} (E2 observation only; not delivery)`,
          ),
        );
      } else {
        proofs.push(
          proof("guarded_stop_mismatch", "unproved", "detached worker did not survive production terminateChild"),
        );
        proofs.push(
          proof("guarded_stop_match", "unproved", "detached worker did not survive production terminateChild"),
        );
        proofs.push(
          proof("single_terminal_observation", "unproved", "detached worker did not survive production terminateChild"),
        );
      }

      const trackedIdentities: Array<{ id: string; identity: ProcessIdentity }> = [];
      if (oldLive.ok) trackedIdentities.push({ id: "old_child", identity: oldLive.identity });
      for (const identity of leftover.splice(0)) {
        if (identitiesEqual(identity, replacementIdentity)) continue;
        trackedIdentities.push({ id: `pid:${identity.pid}`, identity });
      }
      trackedIdentities.push({ id: "replacement", identity: replacementIdentity });

      const cleanupRows: Array<{ id: string; action: string; reason: string }> = [];
      let cleanupSignalOk = true;
      for (const row of trackedIdentities) {
        const signaled = await identitySafeSignal(row.identity, probe, "kill");
        cleanupRows.push({ id: row.id, action: signaled.action, reason: signaled.reason });
        if (signaled.action === "refused") cleanupSignalOk = false;
      }

      const postCleanup: Array<{ id: string; result: string }> = [];
      let cleanupGone = cleanupSignalOk;
      for (const row of trackedIdentities) {
        const live = probe(row.identity.pid);
        if (!live.ok && live.code === "not_found") {
          postCleanup.push({ id: row.id, result: "not_found" });
          continue;
        }
        if (!live.ok) {
          postCleanup.push({ id: row.id, result: `indeterminate:${live.code}` });
          cleanupGone = false;
          leftover.push(row.identity);
          continue;
        }
        if (identitiesEqual(live.identity, row.identity)) {
          postCleanup.push({ id: row.id, result: "exact_identity_still_live" });
          leftover.push(row.identity);
          cleanupGone = false;
          continue;
        }
        postCleanup.push({ id: row.id, result: "different_identity" });
      }
      proofs.push(
        proof(
          "identity_safe_cleanup",
          cleanupGone ? "proved" : "candidate_failed",
          cleanupGone
            ? "signaled only on exact identity match; every stored identity re-probed not_found or a different full identity"
            : `signalRefused=${String(!cleanupSignalOk)} post=${postCleanup.map((p) => `${p.id}:${p.result}`).join(",")}`,
        ),
      );

      const receipt = {
        schemaVersion: 4,
        experiment: "story0-e2-process-capability",
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        stage: "complete",
        harnessError: null,
        proofs,
        productionPath: {
          handoffKind: result.kind,
          oldChildCleanup: result.oldChildCleanup,
          terminateChildLog: logLines.filter((l) => l.includes("termination")),
          spawnedPids,
          ptyPid,
          oldChildPid: manifest.oldChildPid,
          oldChildAfter: oldChildGone ? "not_found" : oldChildAfter.ok ? "ok" : oldChildAfter.code,
          replacementPid: replacementIdentity.pid,
          replacementPtyPid: spawnedPids[1] ?? null,
        },
        processes: manifest.processes.map((row) => ({
          id: row.id,
          launch: row.launch,
          identityBefore: before[row.id] ? processIdentityJson(before[row.id]!) : null,
          after: afterStatus(after[row.id]),
          affiliationBefore: affiliationBefore[row.id] ?? null,
        })),
        outputIdentity,
        d12: {
          status: "unproved",
          artifactRequirementEliminated: false,
          filePresentAfterParentDeath: fileExists(candidates[0]!.outputPath),
        },
        cleanup: cleanupRows,
        postCleanup,
      };
      writeReceipt(receiptPath(), receipt);
      assembled = true;
      process.stdout.write(
        `story0-process-capability platform=${process.platform} ${proofs.map((p) => `${p.id}:${p.status}`).join(" ")} receipt=${receiptPath()}\n`,
      );

      const required = [
        "native_process_identity",
        "production_termination_path",
        "attached_in_production_termination_set",
        "survives_production_old_child_termination",
        "guarded_stop_mismatch",
        "guarded_stop_match",
        "single_terminal_observation",
        "identity_safe_cleanup",
      ];
      if (process.platform !== "win32") {
        required.push("posix_detached_own_session", "output_identity_d7");
      }
      for (const id of required) {
        expect(proofs.find((p) => p.id === id)?.status, id).toBe("proved");
      }

      await runPromise;
    } catch (cause) {
      if (!assembled) writeFailureReceipt(cause);
      throw cause;
    }
  }, 30_000);
});
