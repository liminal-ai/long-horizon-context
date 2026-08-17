/**
 * LIM-80 Slice 3A repairability: runContextMutation on the recovery-port path
 * classifies each failure with a typed disposition, and the durable attempt is
 * left OPEN at the TRUTHFUL stage (never terminalized here). The wrapper leaves
 * transient/recoverable failures scheduled and re-plans from these facts.
 *
 * Crash matrix: baseline unreadable, recordBaseline throw (store I/O), preview
 * failure, compact failure, view-installed record throw, post-compact input
 * fence, rollout verify failure.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Lhc, ThreadRef } from "lhc";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ContextMutationPlan, runContextMutation } from "../../src/commands/context-mutation.js";
import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import { createStoreBackedRecoveryPort } from "../../src/commands/recovery-port.js";
import { BUILTIN_CONTEXT_POLICY } from "../../src/governor/config.js";
import { applyGovernorLifecycleBatch, createGovernorRuntimeState } from "../../src/governor/observe-state.js";
import { type GovernorReceiptStore, openGovernorReceiptStore } from "../../src/governor/receipt-store.js";
import type { GovernorObserveRecord, ResolvedContextPolicy } from "../../src/governor/types.js";
import { rolloutPathForSession } from "../../src/rollout/sessions-index.js";
import * as writeRebuilt from "../../src/rollout/write-rebuilt.js";
import type { ProcessIdentity } from "../../src/runtime/process-identity.js";

const SELF: ProcessIdentity = { pid: 4242, bootId: "boot", starttime: "99" };
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function armed(): ResolvedContextPolicy {
  const policy = { ...BUILTIN_CONTEXT_POLICY, autoCompact: true };
  const sources = Object.fromEntries(
    Object.keys(policy).map((k) => [k, "builtin"]),
  ) as ResolvedContextPolicy["sources"];
  return { policy, sources, armed: true, errors: [] };
}

function settledObserve(): GovernorObserveRecord {
  const { observes } = applyGovernorLifecycleBatch(
    createGovernorRuntimeState({ captureHealthy: true, captureGeneration: 3, descriptorReady: true }),
    [
      { kind: "turn_opened", reason: "user_prompt" },
      {
        kind: "sampling_observed",
        samplingId: "s1",
        providerUsage: { input_tokens: 200_000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 80_000 },
      },
      { kind: "post_measurement_estimate", tokens: 5_000, source: "lhc_token_estimate" },
      { kind: "turn_settled", reason: "end_turn" },
    ],
    armed(),
  );
  return observes.filter((o) => o.observePhase === "settled_seam")[0]!;
}

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-lhc-disp-"));
  dirs.push(dir);
  return join(dir, "cc-lhc.sqlite");
}

/** Real store with a receipt + one attempt claimed by SELF (operation_claimed). */
function seedClaimed(dbPath: string) {
  const store = openGovernorReceiptStore(dbPath);
  store.appendObserve({ observe: settledObserve(), sessionId: "old-cm", threadId: "th_cm" });
  const receiptId = store.listBySession("old-cm")[0]!.receiptId;
  const claim = store.claimAttempt({ receiptId, owner: SELF });
  if (claim.kind !== "claimed") throw new Error(`seed claim ${claim.kind}`);
  return { store, receiptId, attemptId: claim.attempt.attemptId };
}

function storedView(viewId: string) {
  return {
    ok: true as const,
    value: {
      viewId,
      createdAt: "2026-08-17T00:00:00.000Z",
      compactPoint: 1,
      coveredFrom: 0,
      profileName: "continuation",
      config: { lowerBound: 200, percentages: {} },
      arrangement: [],
      gaps: [],
      sourceState: { maxEventOrder: 9, derivationCounts: {} },
      bands: [],
    },
  };
}

interface SdkOpts {
  describe?: () => Promise<unknown>;
  preview?: () => Promise<unknown>;
  compact?: () => Promise<unknown>;
}

function sdkMock(opts: SdkOpts = {}) {
  return {
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
      prune: vi.fn(async () => ({
        ok: true,
        value: { noOp: false, zoneTokensBefore: 500, zoneTokensAfter: 200 },
      })),
      previewCompact: vi.fn(opts.preview ?? (async () => ({ ok: true, value: { kind: "ok" } }))),
      compact: vi.fn(
        opts.compact ??
          (async () => ({
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
      ),
      describe: vi.fn(opts.describe ?? (async () => storedView("v1"))),
      getSessionThreadView: vi.fn(async () => ({
        ok: true,
        value: { threadId: "th_cm", entries: [{ role: "user", content: "hi", sourceMessages: [] }] },
      })),
    },
  };
}

function runtimeWith(sdk: ReturnType<typeof sdkMock>, overrides: Partial<LhcCommandRuntime> = {}): LhcCommandRuntime {
  return {
    captureDisabled: false,
    stats: { threadId: "th_cm" } as unknown as LhcCommandRuntime["stats"],
    sdk: sdk as unknown as Lhc,
    threadRef: { threadId: "th_cm", registryPath: "/tmp/r.sqlite" } as ThreadRef,
    cwd: "/work/cm",
    sourceRolloutPath: undefined,
    sourceSessionId: "old-cm",
    isTurnOpen: () => false,
    isCaptureHealthy: () => true,
    isCaptureReady: () => true,
    getCaptureGeneration: () => 1,
    captureGeneration: 1,
    capturePhase: "ready",
    ...overrides,
  };
}

const PLAN: ContextMutationPlan = { operation: "auto_compact", profile: "continuation", lowerBoundTokens: 240_000 };

/** Disposition of a non-rebuilt outcome (rebuilt carries none). */
function dispositionOf(o: Awaited<ReturnType<typeof runContextMutation>>): string | undefined {
  return o.kind === "rebuilt" ? undefined : o.disposition;
}

function portFor(store: GovernorReceiptStore, receiptId: string, attemptId: string, projectsRoot: string) {
  return createStoreBackedRecoveryPort({
    store,
    receiptId,
    attemptId,
    cwd: "/work/cm",
    threadId: "th_cm",
    oldSessionId: "old-cm",
    projectsRoot,
    newSessionId: () => "sid-rebuilt",
  });
}

describe("recovery-port mutation dispositions (LIM-80 Slice 3A repairability)", () => {
  it("baseline unreadable → retryable_pre_mutation; attempt stays operation_claimed with no baseline", async () => {
    const { store, receiptId, attemptId } = seedClaimed(freshDb());
    const sdk = sdkMock({ describe: async () => ({ ok: false, error: { reason: "io" } }) });
    const port = portFor(store, receiptId, attemptId, "/proj");
    const outcome = await runContextMutation(PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("refused");
    expect(dispositionOf(outcome)).toBe("retryable_pre_mutation");
    expect(sdk.threadView.previewCompact).not.toHaveBeenCalled();
    const a = store.getAttempt(receiptId)!;
    expect(a.stage).toBe("operation_claimed");
    expect(a.artifacts.preMutationViewFingerprint).toBeUndefined();
    store.close();
  });

  it("baseline is proven before an optional due-prune, so unreadable baseline cannot mutate", async () => {
    const { store, receiptId, attemptId } = seedClaimed(freshDb());
    const sdk = sdkMock({ describe: async () => ({ ok: false, error: { reason: "io" } }) });
    sdk.threadView.status.mockResolvedValue({
      ok: true,
      value: {
        tailTokens: 10,
        threshold: 100,
        visibility: { zoneTokens: 500, maxTokens: 1_000 },
        derivation: { pending: 0, failed: 0 },
      },
    });
    const port = portFor(store, receiptId, attemptId, "/proj");
    const outcome = await runContextMutation(
      { ...PLAN, pruneIfDue: { thresholdTokens: 400, targetTokens: 200 } },
      runtimeWith(sdk),
      port,
    );
    expect(outcome.kind).toBe("refused");
    expect(dispositionOf(outcome)).toBe("retryable_pre_mutation");
    expect(sdk.threadView.status).not.toHaveBeenCalled();
    expect(sdk.threadView.prune).not.toHaveBeenCalled();
    expect(store.getAttempt(receiptId)!.artifacts.preMutationViewFingerprint).toBeUndefined();
    store.close();
  });

  it("recordBaseline throw (store I/O) → runContextMutation throws; attempt stays operation_claimed", async () => {
    const { store, receiptId, attemptId } = seedClaimed(freshDb());
    const sdk = sdkMock();
    // Wrap the store so advanceAttempt (recordBaseline) throws a transient I/O error.
    const throwingStore: GovernorReceiptStore = {
      ...store,
      advanceAttempt: () => {
        throw new Error("SQLITE_IOERR: disk I/O error");
      },
    };
    const port = portFor(throwingStore, receiptId, attemptId, "/proj");
    await expect(runContextMutation(PLAN, runtimeWith(sdk), port)).rejects.toThrow(/disk I\/O/);
    // Nothing advanced: still operation_claimed.
    expect(store.getAttempt(receiptId)!.stage).toBe("operation_claimed");
    store.close();
  });

  it("preview failure → retryable_pre_mutation; attempt operation_claimed WITH baseline recorded", async () => {
    const { store, receiptId, attemptId } = seedClaimed(freshDb());
    const sdk = sdkMock({ preview: async () => ({ ok: false, error: { reason: "derivation pending" } }) });
    const port = portFor(store, receiptId, attemptId, "/proj");
    const outcome = await runContextMutation(PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("refused");
    expect(dispositionOf(outcome)).toBe("retryable_pre_mutation");
    expect(sdk.threadView.compact).not.toHaveBeenCalled();
    const a = store.getAttempt(receiptId)!;
    expect(a.stage).toBe("operation_claimed");
    expect(a.artifacts.preMutationViewFingerprint).toBeDefined();
    store.close();
  });

  it("compact failure → retryable_pre_mutation; attempt operation_claimed with baseline", async () => {
    const { store, receiptId, attemptId } = seedClaimed(freshDb());
    const sdk = sdkMock({ compact: async () => ({ ok: false, error: { reason: "compact busy" } }) });
    const port = portFor(store, receiptId, attemptId, "/proj");
    const outcome = await runContextMutation(PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("refused");
    expect(dispositionOf(outcome)).toBe("retryable_pre_mutation");
    const a = store.getAttempt(receiptId)!;
    expect(a.stage).toBe("operation_claimed");
    expect(a.artifacts.viewId).toBeUndefined();
    store.close();
  });

  it("view installed but view_installed record throws → recoverable_post_mutation; attempt open at operation_claimed", async () => {
    const { store, receiptId, attemptId } = seedClaimed(freshDb());
    const sdk = sdkMock();
    // recordBaseline advances once (operation_claimed, same stage); recordViewInstalled
    // (advance to view_installed) throws transient I/O.
    let advanceCalls = 0;
    const flakyStore: GovernorReceiptStore = {
      ...store,
      advanceAttempt: (args) => {
        advanceCalls += 1;
        if (args.stage === "view_installed") throw new Error("SQLITE_BUSY");
        return store.advanceAttempt(args);
      },
    };
    const port = portFor(flakyStore, receiptId, attemptId, "/proj");
    const outcome = await runContextMutation(PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("partial");
    expect(dispositionOf(outcome)).toBe("recoverable_post_mutation");
    expect(advanceCalls).toBeGreaterThanOrEqual(2);
    // Truthful durable stage: view_installed did NOT land, baseline did.
    const a = store.getAttempt(receiptId)!;
    expect(a.stage).toBe("operation_claimed");
    expect(a.artifacts.preMutationViewFingerprint).toBeDefined();
    store.close();
  });

  it("post-compact input fence → recoverable_post_mutation; attempt open at view_installed", async () => {
    const { store, receiptId, attemptId } = seedClaimed(freshDb());
    const sdk = sdkMock();
    const port = portFor(store, receiptId, attemptId, "/proj");
    // Input arrives only AFTER the compact (fence trips post-mutation).
    let compacted = false;
    const baseCompact = sdk.threadView.compact;
    sdk.threadView.compact = vi.fn(async (...args: unknown[]) => {
      compacted = true;
      return (baseCompact as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as never;
    const runtime = runtimeWith(sdk, { inputEpochChanged: () => compacted });
    const outcome = await runContextMutation(PLAN, runtime, port);
    expect(outcome.kind).toBe("partial");
    expect(dispositionOf(outcome)).toBe("recoverable_post_mutation");
    const a = store.getAttempt(receiptId)!;
    expect(a.stage).toBe("view_installed");
    expect(a.artifacts.installedViewFingerprint).toBeDefined();
    store.close();
  });

  it("rollout verify failure → recoverable_post_mutation; attempt open at view_installed (reservation recorded)", async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), "cc-lhc-disp-proj-"));
    dirs.push(projectsRoot);
    const { store, receiptId, attemptId } = seedClaimed(freshDb());
    const sdk = sdkMock();
    const port = portFor(store, receiptId, attemptId, projectsRoot);
    const reservedPath = rolloutPathForSession(projectsRoot, "/work/cm", "sid-rebuilt");
    // Write a STRUCTURALLY INVALID rollout (wrong sessionId) at the reserved path:
    // the write "succeeds" but whole-file verification fails → partial, no rollout_written.
    vi.spyOn(writeRebuilt, "writeRebuiltRollout").mockImplementation(async (input) => {
      const bad = {
        type: "user",
        uuid: "u0",
        parentUuid: null,
        sessionId: "WRONG-SESSION",
        message: { role: "user", content: `[runtime note] ${input.receipt?.text ?? ""}` },
      };
      await mkdir(dirname(reservedPath), { recursive: true });
      await writeFile(reservedPath, `${JSON.stringify(bad)}\n`, "utf8");
      return {
        sessionId: "sid-rebuilt",
        rolloutPath: reservedPath,
        lineCount: 1,
        expectedReintakeLines: 1,
        replayedPrefixLines: 0,
        prefixBoundary: { kind: "verified" as const, lineCount: 0, byteLength: 0, sha256: "0".repeat(64) },
        totalByteLength: 10,
      };
    });
    const outcome = await runContextMutation(PLAN, runtimeWith(sdk), port);
    expect(outcome.kind).toBe("partial");
    expect(dispositionOf(outcome)).toBe("recoverable_post_mutation");
    const a = store.getAttempt(receiptId)!;
    // view_installed + reservation recorded; rollout_written did NOT land.
    expect(a.stage).toBe("view_installed");
    expect(a.artifacts.rebuiltSessionId).toBe("sid-rebuilt");
    expect(a.artifacts.rolloutFullSha256).toBeUndefined();
    store.close();
  });
});
