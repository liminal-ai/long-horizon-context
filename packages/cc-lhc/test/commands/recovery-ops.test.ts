/**
 * LIM-80 Slice 2: command-layer recovery executors.
 *
 * Central no-duplicate-compact + whole-file verification proofs use a real
 * temporary LHC SDK thread and real rebuilt-rollout writes under a temp
 * projects root. Failure paths inject read/write fakes.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type ThreadRef, threads } from "lhc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LhcCommandRuntime } from "../../src/commands/dispatch.js";
import {
  captureViewBaselineFingerprint,
  inspectRolloutBytes,
  materializeRolloutFromInstalledView,
  observeCurrentStoredView,
  recoverReservedRollout,
} from "../../src/commands/recovery-ops.js";
import { NO_STORED_VIEW_FINGERPRINT } from "../../src/governor/recovery.js";
import { readSessionsIndex, rolloutPathForSession } from "../../src/rollout/sessions-index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("recovery-ops: installed-view + rollout recovery (LIM-80 Slice 2)", () => {
  let root: string;
  let projectsRoot: string;
  let cwd: string;
  let filePath: string;
  let registryPath: string;
  let sdk: Lhc;
  let threadRef: ThreadRef;
  let runtime: LhcCommandRuntime;
  let installedFingerprint: string;

  async function seedTurns(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const send = await sdk.intakeStream.messageEvents({ filePath }, [
        {
          eventKind: "user_prompt",
          idempotencyKey: `u${i}`,
          actor: "user",
          harness: "cc",
          payload: { text: `prompt ${i} ${"x".repeat(50)}` },
        },
        {
          eventKind: "assistant_text",
          idempotencyKey: `a${i}`,
          actor: "assistant",
          harness: "cc",
          payload: { text: `answer ${i} ${"y".repeat(50)}` },
        },
        { eventKind: "turn_end", idempotencyKey: `e${i}`, actor: "system", harness: "cc", payload: {} },
      ]);
      if (!send.ok) throw new Error(send.error.reason);
    }
    const drained = await sdk.work.drain({ filePath });
    if (!drained.ok) throw new Error(drained.error.reason);
  }

  async function compactAndFingerprint(): Promise<string> {
    const compact = await sdk.threadView.compact(threadRef, { profile: "continuation", params: { lowerBound: 200 } });
    expect(compact.ok).toBe(true);
    const observed = await observeCurrentStoredView(sdk, threadRef);
    if (observed.kind !== "present") throw new Error("expected installed view");
    return observed.fingerprint;
  }

  const reservedPath = (sessionId: string): string => rolloutPathForSession(projectsRoot, cwd, sessionId);

  beforeEach(async () => {
    root = scratch("cc-lhc-recops-");
    projectsRoot = join(root, "projects");
    cwd = join(root, "work");
    filePath = join(root, "thread.sqlite");
    registryPath = join(root, "registry.sqlite");
    const created = await threads.newThread({ filePath, registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    threadRef = { filePath } as unknown as ThreadRef;
    runtime = {
      captureDisabled: false,
      stats: { threadId: created.value.threadId } as unknown as LhcCommandRuntime["stats"],
      sdk,
      threadRef,
      cwd,
      sourceRolloutPath: undefined,
      sourceSessionId: "old-session",
    };
    installedFingerprint = "";
  });

  it("no previous view → baseline is the sentinel; after compact the view is present and differs", async () => {
    await seedTurns(6);
    expect(await captureViewBaselineFingerprint(sdk, threadRef)).toBe(NO_STORED_VIEW_FINGERPRINT);
    installedFingerprint = await compactAndFingerprint();
    expect(installedFingerprint).not.toBe(NO_STORED_VIEW_FINGERPRINT);
  });

  it("materialize performs ZERO preview/compact/prune, verifies whole-file identity, requires the expected fingerprint", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();

    const previewSpy = vi.spyOn(sdk.threadView, "previewCompact");
    const compactSpy = vi.spyOn(sdk.threadView, "compact");
    const pruneSpy = vi.spyOn(sdk.threadView, "prune");

    const reservedSessionId = "11111111-2222-3333-4444-555555555555";
    const out = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: "[lhc compact:auto] recovered from installed view",
      operation: "auto_compact",
      projectsRoot,
    });
    expect(out.kind).toBe("materialized");
    if (out.kind !== "materialized") return;
    expect(previewSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(pruneSpy).not.toHaveBeenCalled();
    expect(out.rebuilt.sessionId).toBe(reservedSessionId);
    expect(out.verification.rebuiltRolloutPath).toBe(reservedPath(reservedSessionId));
    expect(out.verification.rolloutFullSha256).toHaveLength(64);

    // The recorded verification is exactly what a whole-file inspection derives.
    const buf = await readFile(out.rebuilt.rolloutPath);
    const inspected = inspectRolloutBytes(buf, {
      reservedSessionId,
      rebuiltRolloutPath: out.rebuilt.rolloutPath,
      durableReceipt: "[lhc compact:auto] recovered from installed view",
    });
    expect(inspected.kind).toBe("ok");
    if (inspected.kind === "ok") expect(inspected.verification).toEqual(out.verification);
  });

  it("materialize refuses on fingerprint drift and on a reserved-path mismatch", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "22222222-3333-4444-5555-666666666666";

    const drift = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: "some-other-fingerprint",
      durableReceiptText: "r",
      operation: "auto_compact",
      projectsRoot,
    });
    expect(drift.kind).toBe("drift");

    const mismatch = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: "/somewhere/else.jsonl",
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: "r",
      operation: "auto_compact",
      projectsRoot,
    });
    expect(mismatch.kind).toBe("invalid");
  });

  it("degraded / summary-only view (undrained derivations) still materializes and verifies", async () => {
    await seedTurns(4);
    const send = await sdk.intakeStream.messageEvents({ filePath }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: "uD",
        actor: "user",
        harness: "cc",
        payload: { text: `late ${"z".repeat(80)}` },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: "aD",
        actor: "assistant",
        harness: "cc",
        payload: { text: `late-a ${"w".repeat(80)}` },
      },
      { eventKind: "turn_end", idempotencyKey: "eD", actor: "system", harness: "cc", payload: {} },
    ]);
    if (!send.ok) throw new Error(send.error.reason);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const out = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: "[lhc compact:auto] degraded view",
      operation: "auto_compact",
      projectsRoot,
    });
    expect(out.kind).toBe("materialized");
    if (out.kind === "materialized") expect(out.verification.rolloutByteLength).toBeGreaterThan(0);
  });

  it("reserved rollout absent (ENOENT) → recover rematerializes to the SAME session id", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "99999999-8888-7777-6666-555555555555";
    const recovered = await recoverReservedRollout({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      durableReceiptText: "[lhc compact:auto] rematerialized",
      expectedInstalledFingerprint: installedFingerprint,
      operation: "auto_compact",
      projectsRoot,
      // No `recorded`: crash before recordRolloutWritten.
    });
    expect(recovered.kind).toBe("rematerialized");
    if (recovered.kind === "rematerialized") expect(recovered.rebuilt.sessionId).toBe(reservedSessionId);
  });

  it("reserved rollout present but recorded verification absent → inspect, derive verification, reuse (no rewrite)", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "12341234-1234-1234-1234-123412341234";
    const receipt = "[lhc compact:auto] written";
    const written = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: receipt,
      operation: "auto_compact",
      projectsRoot,
    });
    if (written.kind !== "materialized") throw new Error("write failed");
    const before = readFileSync(written.rebuilt.rolloutPath, "utf8");
    // Recover with ONLY durable reservation + receipt (no recorded verification).
    const recovered = await recoverReservedRollout({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      durableReceiptText: receipt,
      expectedInstalledFingerprint: installedFingerprint,
      operation: "auto_compact",
      projectsRoot,
    });
    expect(recovered.kind).toBe("reused");
    if (recovered.kind === "reused") {
      expect(recovered.verification.rebuiltSessionId).toBe(reservedSessionId);
      expect(recovered.handoff.rebuilt.sessionId).toBe(reservedSessionId);
    }
    expect(readFileSync(written.rebuilt.rolloutPath, "utf8")).toBe(before);
  });

  it("recorded verification present and matching → reuse; a same-length trailing mutation fails on whole-file digest", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "cccccccc-dddd-eeee-ffff-000011112222";
    const receipt = "[lhc compact:auto] rec";
    const written = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: receipt,
      operation: "auto_compact",
      projectsRoot,
    });
    if (written.kind !== "materialized") throw new Error("write failed");
    const recorded = written.verification;

    const ok = await recoverReservedRollout({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      durableReceiptText: receipt,
      expectedInstalledFingerprint: installedFingerprint,
      operation: "auto_compact",
      projectsRoot,
      recorded,
    });
    expect(ok.kind).toBe("reused");

    // Same-BYTE-LENGTH mutation of the trailing receipt line: swap two chars in
    // the note text so the file keeps its length but its content changes.
    const original = readFileSync(written.rebuilt.rolloutPath, "utf8");
    const marker = "] rec";
    const idx = original.lastIndexOf(marker);
    expect(idx).toBeGreaterThan(0);
    const mutated = `${original.slice(0, idx)}] rce${original.slice(idx + marker.length)}`;
    expect(mutated.length).toBe(original.length);
    writeFileSync(written.rebuilt.rolloutPath, mutated);
    const bad = await recoverReservedRollout({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      durableReceiptText: receipt,
      expectedInstalledFingerprint: installedFingerprint,
      operation: "auto_compact",
      projectsRoot,
      recorded,
    });
    expect(bad.kind).toBe("invalid");
  });

  it("wrong session, line role/type, and broken parent chain fail structurally (fail closed)", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "44445555-6666-7777-8888-99990000aaaa";
    const receipt = "[lhc compact:auto] chain";
    const written = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: receipt,
      operation: "auto_compact",
      projectsRoot,
    });
    if (written.kind !== "materialized") throw new Error("write failed");
    const lines = readFileSync(written.rebuilt.rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));

    // Wrong sessionId on the first line.
    const wrongSession = structuredClone(lines);
    wrongSession[0].sessionId = "someone-else";
    expect(
      inspectRolloutBytes(Buffer.from(`${wrongSession.map((l) => JSON.stringify(l)).join("\n")}\n`), {
        reservedSessionId,
        rebuiltRolloutPath: written.rebuilt.rolloutPath,
        durableReceipt: receipt,
      }).kind,
    ).toBe("invalid");

    const wrongRole = structuredClone(lines);
    wrongRole[0].message.role = wrongRole[0].type === "user" ? "assistant" : "user";
    expect(
      inspectRolloutBytes(Buffer.from(`${wrongRole.map((l) => JSON.stringify(l)).join("\n")}\n`), {
        reservedSessionId,
        rebuiltRolloutPath: written.rebuilt.rolloutPath,
        durableReceipt: receipt,
      }).kind,
    ).toBe("invalid");

    const wrongType = structuredClone(lines);
    wrongType[0].type = "summary";
    expect(
      inspectRolloutBytes(Buffer.from(`${wrongType.map((l) => JSON.stringify(l)).join("\n")}\n`), {
        reservedSessionId,
        rebuiltRolloutPath: written.rebuilt.rolloutPath,
        durableReceipt: receipt,
      }).kind,
    ).toBe("invalid");

    // Broken parent chain (only meaningful when there is more than one line).
    if (lines.length > 1) {
      const brokenChain = structuredClone(lines);
      brokenChain[1].parentUuid = "not-the-previous-uuid";
      expect(
        inspectRolloutBytes(Buffer.from(`${brokenChain.map((l) => JSON.stringify(l)).join("\n")}\n`), {
          reservedSessionId,
          rebuiltRolloutPath: written.rebuilt.rolloutPath,
          durableReceipt: receipt,
        }).kind,
      ).toBe("invalid");
    }
  });

  it("an unreadable present reserved rollout is retry, never overwritten", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "eeeeeeee-ffff-0000-1111-222233334444";
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const writeSpy = vi.fn();
    const recovered = await recoverReservedRollout({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      durableReceiptText: "r",
      expectedInstalledFingerprint: installedFingerprint,
      operation: "auto_compact",
      projectsRoot,
      readBytesFn: async () => {
        throw eacces;
      },
      writeFn: writeSpy as never,
    });
    expect(recovered.kind).toBe("retry");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("recovering a present valid file repairs a missing sessions-index entry (exactly one)", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "55556666-7777-8888-9999-aaaabbbbcccc";
    const receipt = "[lhc compact:auto] idx";
    const written = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: receipt,
      operation: "auto_compact",
      projectsRoot,
    });
    if (written.kind !== "materialized") throw new Error("write failed");
    // Simulate fsync-before-index crash: delete the index entry that the write made.
    const projectDir = join(projectsRoot, (await import("../../src/rollout/discover.js")).encodeProjectPath(cwd));
    writeFileSync(join(projectDir, "sessions-index.json"), JSON.stringify({ version: 1, entries: [] }));

    const recovered = await recoverReservedRollout({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      durableReceiptText: receipt,
      expectedInstalledFingerprint: installedFingerprint,
      operation: "auto_compact",
      projectsRoot,
    });
    expect(recovered.kind).toBe("reused");
    if (recovered.kind === "reused") expect(recovered.indexRepaired).toBe(true);
    const index = await readSessionsIndex(projectDir);
    const entries = index.entries.filter((e) => e.sessionId === reservedSessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fullPath).toBe(reservedPath(reservedSessionId));
  });

  it("a sessions-index correlation conflict during recovery fails closed (invalid), no verified handoff", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "66667777-8888-9999-aaaa-bbbbccccdddd";
    const receipt = "[lhc compact:auto] conflict";
    const written = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: receipt,
      operation: "auto_compact",
      projectsRoot,
    });
    if (written.kind !== "materialized") throw new Error("write failed");
    // Corrupt the index so the SAME session id is listed at a DIFFERENT path.
    const projectDir = join(projectsRoot, (await import("../../src/rollout/discover.js")).encodeProjectPath(cwd));
    writeFileSync(
      join(projectDir, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            sessionId: reservedSessionId,
            fullPath: "/somewhere/else.jsonl",
            fileMtime: 0,
            firstPrompt: "",
            summary: "",
            messageCount: 1,
            created: "",
            modified: "",
            projectPath: cwd,
            isSidechain: false,
          },
        ],
      }),
    );
    const recovered = await recoverReservedRollout({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      durableReceiptText: receipt,
      expectedInstalledFingerprint: installedFingerprint,
      operation: "auto_compact",
      projectsRoot,
    });
    expect(recovered.kind).toBe("invalid");
  });

  it("transient sessions-index I/O during recovery returns retry, not a handoff", async () => {
    await seedTurns(6);
    installedFingerprint = await compactAndFingerprint();
    const reservedSessionId = "77778888-9999-aaaa-bbbb-ccccddddeeee";
    const receipt = "[lhc compact:auto] transient";
    const written = await materializeRolloutFromInstalledView({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      expectedInstalledFingerprint: installedFingerprint,
      durableReceiptText: receipt,
      operation: "auto_compact",
      projectsRoot,
    });
    if (written.kind !== "materialized") throw new Error("write failed");
    const eio = Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
    const recovered = await recoverReservedRollout({
      runtime,
      reservedSessionId,
      reservedRolloutPath: reservedPath(reservedSessionId),
      durableReceiptText: receipt,
      expectedInstalledFingerprint: installedFingerprint,
      operation: "auto_compact",
      projectsRoot,
      // Force the index append to fail transiently (rename I/O error).
      indexDeps: {
        renameFn: async () => {
          throw eio;
        },
      },
    });
    expect(recovered.kind).toBe("retry");
  });

  it("observeCurrentStoredView surfaces a describe failure as unreadable, not a contradiction", async () => {
    const failing = {
      threadView: { describe: vi.fn(async () => ({ ok: false as const, error: { reason: "db busy" } })) },
    } as unknown as Lhc;
    const observed = await observeCurrentStoredView(failing, threadRef);
    expect(observed.kind).toBe("unreadable");
    if (observed.kind === "unreadable") expect(observed.reason).toBe("db busy");
  });
});
