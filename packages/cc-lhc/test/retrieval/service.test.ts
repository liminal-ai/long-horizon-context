/**
 * Slice 2 correction: service gates, impression deltas, continuation, overflow assert.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createDeterministicInferenceCallbacks, initLhc, type Lhc, retrieval } from "lhc";
import { beforeEach, describe, expect, it } from "vitest";
import { checkSessionBinding, executeRetrieval, runRetrievalCli, writeAll } from "../../src/retrieval/service.js";
import {
  createOpeningDescriptor,
  type DescriptorIo,
  markClosed,
  markDegraded,
  markReady,
  newDescriptorPath,
} from "../../src/runtime/descriptor.js";
import { indeterminateResult, notFoundResult, selfIdentity, selfOnlyProbe } from "../helpers/identity.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "cc-lhc-ret-"));
}

function realIo(): DescriptorIo {
  const fs = require("node:fs") as typeof import("node:fs");
  return {
    writeFile: (p, d, m) => fs.writeFileSync(p, d, { encoding: "utf8", mode: m }),
    readFile: (p) => fs.readFileSync(p, "utf8"),
    rename: fs.renameSync,
    unlink: (p) => {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    },
    exists: fs.existsSync,
    mkdir: (p) => fs.mkdirSync(p, { recursive: true, mode: 0o700 }),
    chmod: fs.chmodSync,
    readProcessIdentity: selfOnlyProbe(),
    nowMs: () => Date.now(),
    randomId: () => `id-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
  };
}

async function seedThread(sdk: Lhc, filePath: string, big = false): Promise<void> {
  const text = big
    ? Array.from({ length: 200 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n")
    : "first answer about the widget";
  const send = await sdk.intakeStream.messageEvents({ filePath }, [
    {
      eventKind: "user_prompt",
      idempotencyKey: `u-${Math.random()}`,
      actor: "user",
      harness: "cc",
      payload: { text: "first question" },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: `a-${Math.random()}`,
      actor: "assistant",
      harness: "cc",
      payload: { text },
    },
    {
      eventKind: "turn_end",
      idempotencyKey: `e-${Math.random()}`,
      actor: "system",
      harness: "cc",
      payload: {},
    },
  ]);
  if (!send.ok) throw new Error(send.error.reason);
  const drain = await sdk.work.drain({ filePath });
  if (!drain.ok) throw new Error(drain.error.reason);
}

function writeRollout(path: string, sessionId: string): void {
  writeFileSync(path, JSON.stringify({ type: "user", sessionId, message: { role: "user", content: "hi" } }) + "\n");
}

describe("checkSessionBinding", () => {
  it("matches live CLAUDE_CODE_SESSION_ID without file I/O", () => {
    const desc = {
      version: 1 as const,
      state: "ready" as const,
      incarnation: "inc-long-enough",
      wrapperPid: process.pid,
      wrapperStartedAtMs: 1,
      processIdentity: selfIdentity(),
      updatedAt: new Date().toISOString(),
      threadId: "th_x",
      registryPath: "/r",
      sessionId: "sid-live",
      rolloutPath: "/r/sid-live.jsonl",
    };
    expect(checkSessionBinding(desc, { CLAUDE_CODE_SESSION_ID: "sid-live" }).ok).toBe(true);
    expect(checkSessionBinding(desc, { CLAUDE_CODE_SESSION_ID: "other" }).ok).toBe(false);
  });

  it("absent env requires real matching rollout evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-bind-"));
    const sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const path = join(dir, `${sid}.jsonl`);
    writeRollout(path, sid);
    const desc = {
      version: 1 as const,
      state: "ready" as const,
      incarnation: "inc-long-enough",
      wrapperPid: process.pid,
      wrapperStartedAtMs: 1,
      processIdentity: selfIdentity(),
      updatedAt: new Date().toISOString(),
      threadId: "th_x",
      registryPath: "/r",
      sessionId: sid,
      rolloutPath: path,
    };
    expect(checkSessionBinding(desc, {}).ok).toBe(true);
    expect(checkSessionBinding({ ...desc, rolloutPath: join(dir, "missing.jsonl") }, {}).ok).toBe(false);
  });
});
describe("executeRetrieval", () => {
  let root: string;
  let sdk: Lhc;
  let registryPath: string;
  let threadFile: string;
  let threadId: string;
  let sessionId: string;
  let rolloutPath: string;
  let descPath: string;
  let io: DescriptorIo;

  beforeEach(async () => {
    root = tempRoot();
    registryPath = join(root, "registry.sqlite");
    mkdirSync(join(root, "threads"), { recursive: true });
    threadFile = join(root, "threads", "t.sqlite");
    sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const created = await sdk.threads.newThread({ filePath: threadFile, registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    threadId = created.value.threadId;
    await seedThread(sdk, threadFile);

    sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    rolloutPath = join(root, `${sessionId}.jsonl`);
    writeRollout(rolloutPath, sessionId);

    io = realIo();
    descPath = newDescriptorPath(root, io);
    let desc = createOpeningDescriptor(descPath, io);
    desc = markReady(descPath, desc, {
      threadId,
      registryPath,
      sessionId,
      rolloutPath,
    });
    void desc;
  });

  async function impressions(): Promise<number> {
    const r = await retrieval.listImpressions({ filePath: threadFile });
    return r.ok ? r.value.length : 0;
  }

  it("syntax error writes zero impressions", async () => {
    const n0 = await impressions();
    const bad = await executeRetrieval(["get-turns", "not-an-id"], {
      descriptorPath: descPath,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sessionId },
      initSdk: () => sdk,
    });
    expect(bad.ok).toBe(false);
    expect(await impressions()).toBe(n0);
  });

  it("opening/degraded/closed/missing each zero impression delta", async () => {
    const n0 = await impressions();

    const openPath = newDescriptorPath(root, io);
    createOpeningDescriptor(openPath, io);
    expect(
      (
        await executeRetrieval(["get-turns", "t1"], {
          descriptorPath: openPath,
          descriptorIo: io,
          env: { CLAUDE_CODE_SESSION_ID: sessionId },
          initSdk: () => sdk,
        })
      ).ok,
    ).toBe(false);
    expect(await impressions()).toBe(n0);

    const degP = newDescriptorPath(root, io);
    let deg = createOpeningDescriptor(degP, io);
    deg = markReady(degP, deg, { threadId, registryPath, sessionId, rolloutPath });
    markDegraded(degP, deg, "test");
    expect(
      (
        await executeRetrieval(["get-turns", "t1"], {
          descriptorPath: degP,
          descriptorIo: io,
          env: { CLAUDE_CODE_SESSION_ID: sessionId },
          initSdk: () => sdk,
        })
      ).ok,
    ).toBe(false);
    expect(await impressions()).toBe(n0);

    const closedP = newDescriptorPath(root, io);
    let cl = createOpeningDescriptor(closedP, io);
    cl = markReady(closedP, cl, { threadId, registryPath, sessionId, rolloutPath });
    markClosed(closedP, cl, io);
    expect(
      (
        await executeRetrieval(["get-turns", "t1"], {
          descriptorPath: closedP,
          descriptorIo: io,
          env: { CLAUDE_CODE_SESSION_ID: sessionId },
          initSdk: () => sdk,
        })
      ).ok,
    ).toBe(false);
    expect(await impressions()).toBe(n0);

    expect(
      (
        await executeRetrieval(["get-turns", "t1"], {
          descriptorPath: join(root, "nope.json"),
          descriptorIo: io,
          env: { CLAUDE_CODE_SESSION_ID: sessionId },
          initSdk: () => sdk,
        })
      ).ok,
    ).toBe(false);
    expect(await impressions()).toBe(n0);
  });

  it("indeterminate owner liveness refuses before any SDK call or impression", async () => {
    const n0 = await impressions();
    let sdkInits = 0;
    const indeterminateIo: DescriptorIo = {
      ...realIo(),
      readProcessIdentity: () => indeterminateResult("access_denied: kernel refused the query"),
    };
    const res = await executeRetrieval(["get-turns", "t1"], {
      descriptorPath: descPath,
      descriptorIo: indeterminateIo,
      env: { CLAUDE_CODE_SESSION_ID: sessionId },
      initSdk: () => {
        sdkInits += 1;
        return sdk;
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.exitCode).toBe(3);
      expect(res.reason).toMatch(/cannot establish current OS process identity/);
    }
    expect(sdkInits).toBe(0);
    expect(await impressions()).toBe(n0);
  });

  it("kernel-proven dead owner refuses as stale before any SDK call or impression", async () => {
    const n0 = await impressions();
    let sdkInits = 0;
    const deadIo: DescriptorIo = {
      ...realIo(),
      readProcessIdentity: (pid) => notFoundResult(pid),
    };
    const res = await executeRetrieval(["get-turns", "t1"], {
      descriptorPath: descPath,
      descriptorIo: deadIo,
      env: { CLAUDE_CODE_SESSION_ID: sessionId },
      initSdk: () => {
        sdkInits += 1;
        return sdk;
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.exitCode).toBe(3);
      expect(res.reason).toMatch(/stale.*not found/);
    }
    expect(sdkInits).toBe(0);
    expect(await impressions()).toBe(n0);
  });

  it("session mismatch refuses with zero impressions", async () => {
    const n0 = await impressions();
    const r = await executeRetrieval(["get-turns", "t1"], {
      descriptorPath: descPath,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: "wrong-session-id" },
      initSdk: () => sdk,
    });
    expect(r.ok).toBe(false);
    expect(await impressions()).toBe(n0);
  });

  it("absent env with missing rollout refuses zero impressions", async () => {
    const n0 = await impressions();
    // ready descriptor points at nonexistent rollout
    const badPath = newDescriptorPath(root, io);
    let d = createOpeningDescriptor(badPath, io);
    d = markReady(badPath, d, {
      threadId,
      registryPath,
      sessionId,
      rolloutPath: join(root, `${sessionId}.jsonl.MISSING`),
    });
    void d;
    // basename won't match either — use correct basename missing file
    const missing = join(root, "missing-dir", `${sessionId}.jsonl`);
    const bad2 = newDescriptorPath(root, io);
    let d2 = createOpeningDescriptor(bad2, io);
    d2 = markReady(bad2, d2, { threadId, registryPath, sessionId, rolloutPath: missing });
    void d2;
    const r = await executeRetrieval(["get-turns", "t1"], {
      descriptorPath: bad2,
      descriptorIo: io,
      env: {},
      initSdk: () => sdk,
    });
    expect(r.ok).toBe(false);
    expect(await impressions()).toBe(n0);
  });

  it("valid get-turns: exact +1 impression per unique id", async () => {
    const n0 = await impressions();
    const r = await executeRetrieval(["get-turns", "t1", "t1"], {
      descriptorPath: descPath,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sessionId },
      initSdk: () => sdk,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.impressionsExpected).toBe(1);
    expect(await impressions()).toBe(n0 + 1);
  });

  it("not-found receipt +1 impression", async () => {
    const n0 = await impressions();
    const r = await executeRetrieval(["get-turns", "t999"], {
      descriptorPath: descPath,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sessionId },
      initSdk: () => sdk,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stdout).toMatch(/not served: t999/);
    expect(await impressions()).toBe(n0 + 1);
  });

  it("continuation --from after slice", async () => {
    // Fresh large thread
    const tf = join(root, "threads", "big.sqlite");
    const created = await sdk.threads.newThread({ filePath: tf, registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    await seedThread(sdk, tf, true);
    const sid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const rp = join(root, `${sid}.jsonl`);
    writeRollout(rp, sid);
    const dp = newDescriptorPath(root, io);
    let d = createOpeningDescriptor(dp, io);
    d = markReady(dp, d, {
      threadId: created.value.threadId,
      registryPath,
      sessionId: sid,
      rolloutPath: rp,
    });
    void d;

    const first = await executeRetrieval(["get-turns", "t1"], {
      descriptorPath: dp,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sid, BASH_MAX_OUTPUT_LENGTH: "4000" },
      initSdk: () => sdk,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.stdout).toMatch(/Next slice:/);
    const m = /--from (\d+) (t\d+)/.exec(first.stdout);
    expect(m).not.toBeNull();
    const beforeImps = await retrieval.listImpressions({ filePath: tf });
    expect(beforeImps.ok).toBe(true);
    if (!beforeImps.ok) return;
    const nBefore = beforeImps.value.length;
    const second = await executeRetrieval(["get-turns", "--from", m![1]!, m![2]!], {
      descriptorPath: dp,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sid, BASH_MAX_OUTPUT_LENGTH: "4000" },
      initSdk: () => sdk,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.stdout).toContain("<recalled-history");
    const afterImps = await retrieval.listImpressions({ filePath: tf });
    expect(afterImps.ok).toBe(true);
    if (!afterImps.ok) return;
    expect(afterImps.value.length - nBefore).toBe(1);
  });

  it("oversized first entity: Next slice + second entity budget Pull it separately (turns)", async () => {
    // Two real turns: t1 huge (bytes force slice), t2 short valid.
    const tf = join(root, "threads", "budget-pair-turns.sqlite");
    const created = await sdk.threads.newThread({ filePath: tf, registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    // Production-shaped whitespace-delimited phrases with multibyte text.
    // Dense multibyte fills the 32-id body budget so t2 is initial zero-served
    // (from=0,to=0,total>0) and the host projects budget "Pull it separately".
    // Do not use unbroken "A".repeat — it can pin the tokenizer pathologically.
    const phrase = "運用記録 日本語 🔧 ";
    const big = phrase.repeat(1500);
    await sdk.intakeStream.messageEvents({ filePath: tf }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: `u-big-${Math.random()}`,
        actor: "user",
        harness: "cc",
        payload: { text: big },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: `a-big-${Math.random()}`,
        actor: "assistant",
        harness: "cc",
        payload: { text: "ack big" },
      },
      {
        eventKind: "turn_end",
        idempotencyKey: `e-big-${Math.random()}`,
        actor: "system",
        harness: "cc",
        payload: {},
      },
      {
        eventKind: "user_prompt",
        idempotencyKey: `u-s-${Math.random()}`,
        actor: "user",
        harness: "cc",
        payload: { text: "short second turn body" },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: `a-s-${Math.random()}`,
        actor: "assistant",
        harness: "cc",
        payload: { text: "ack short" },
      },
      {
        eventKind: "turn_end",
        idempotencyKey: `e-s-${Math.random()}`,
        actor: "system",
        harness: "cc",
        payload: {},
      },
    ]);
    await sdk.work.drain({ filePath: tf });

    const sid = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const rp = join(root, `${sid}.jsonl`);
    writeRollout(rp, sid);
    const dp = newDescriptorPath(root, io);
    let d = createOpeningDescriptor(dp, io);
    d = markReady(dp, d, {
      threadId: created.value.threadId,
      registryPath,
      sessionId: sid,
      rolloutPath: rp,
    });
    void d;

    const imps0 = await retrieval.listImpressions({ filePath: tf });
    if (!imps0.ok) throw new Error(imps0.error.reason);
    const n0 = imps0.value.length;
    // 32 unique-id reservation shape forces small body budget
    const ids = ["t1", "t2", ...Array.from({ length: 30 }, (_, i) => `t${String(900000 + i).padStart(12, "0")}`)];
    const r = await executeRetrieval(["get-turns", ...ids], {
      descriptorPath: dp,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sid },
      initSdk: () => sdk,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stdout).toMatch(/Next slice:/);
    expect(r.stdout).toMatch(
      /not served: t2 \(\d+ tok — call budget spent\)\. Pull it separately: cc-lhc get-turns t2/,
    );
    expect(r.stdout).not.toMatch(/\[t2: nothing at token offset 0/);
    expect(r.impressionsExpected).toBe(32);
    const imps = await retrieval.listImpressions({ filePath: tf });
    expect(imps.ok).toBe(true);
    if (!imps.ok) return;
    expect(imps.value.length - n0).toBe(32);
    // One call id for all 32
    const lastCall = imps.value[imps.value.length - 1]!.callId;
    const forCall = imps.value.filter((row) => row.callId === lastCall);
    expect(forCall).toHaveLength(32);

    // Separate pull of t2 succeeds with real body
    const solo = await executeRetrieval(["get-turns", "t2"], {
      descriptorPath: dp,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sid },
      initSdk: () => sdk,
    });
    expect(solo.ok).toBe(true);
    if (!solo.ok) return;
    expect(solo.stdout).toMatch(/short second turn body|ack short/);
    expect(solo.stdout).not.toMatch(/call budget spent/);
  }, 30_000);

  it("oversized first entity: budget Pull it separately for messages", async () => {
    const tf = join(root, "threads", "budget-pair-msgs.sqlite");
    const created = await sdk.threads.newThread({ filePath: tf, registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    // Same dense multibyte body strategy as the turns budget-pair test.
    const phrase = "運用記録 日本語 🔧 ";
    const big = phrase.repeat(1500);
    await sdk.intakeStream.messageEvents({ filePath: tf }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: `u-m-${Math.random()}`,
        actor: "user",
        harness: "cc",
        payload: { text: big },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: `a-m-${Math.random()}`,
        actor: "assistant",
        harness: "cc",
        payload: { text: "reply-m" },
      },
      {
        eventKind: "turn_end",
        idempotencyKey: `e-m-${Math.random()}`,
        actor: "system",
        harness: "cc",
        payload: {},
      },
    ]);
    await sdk.work.drain({ filePath: tf });
    // messages: m1 user huge, m2 assistant short
    const sid = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const rp = join(root, `${sid}.jsonl`);
    writeRollout(rp, sid);
    const dp = newDescriptorPath(root, io);
    let d = createOpeningDescriptor(dp, io);
    d = markReady(dp, d, {
      threadId: created.value.threadId,
      registryPath,
      sessionId: sid,
      rolloutPath: rp,
    });
    void d;

    const imps0 = await retrieval.listImpressions({ filePath: tf });
    if (!imps0.ok) throw new Error(imps0.error.reason);
    const n0 = imps0.value.length;
    const r = await executeRetrieval(
      ["get-messages", "m1", "m2", ...Array.from({ length: 30 }, (_, i) => `m${String(800000 + i).padStart(12, "0")}`)],
      {
        descriptorPath: dp,
        descriptorIo: io,
        env: { CLAUDE_CODE_SESSION_ID: sid },
        initSdk: () => sdk,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stdout).toMatch(/Next slice:/);
    expect(r.stdout).toMatch(
      /not served: m2 \(\d+ tok — call budget spent\)\. Pull it separately: cc-lhc get-messages m2/,
    );
    expect(r.stdout).not.toMatch(/\[m2: nothing at token offset 0/);
    const imps = await retrieval.listImpressions({ filePath: tf });
    expect(imps.ok).toBe(true);
    if (!imps.ok) return;
    expect(imps.value.length - n0).toBe(32);

    const solo = await executeRetrieval(["get-messages", "m2"], {
      descriptorPath: dp,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sid },
      initSdk: () => sdk,
    });
    expect(solo.ok).toBe(true);
    if (!solo.ok) return;
    expect(solo.stdout).toMatch(/reply-m/);
  }, 30_000);

  it("injected oversize SDK body throws RETRIEVAL_ENVELOPE_INVARIANT (not pre-SDK refusal)", async () => {
    const n0 = await impressions();
    await expect(
      executeRetrieval(["get-turns", "t1"], {
        descriptorPath: descPath,
        descriptorIo: io,
        env: { CLAUDE_CODE_SESSION_ID: sessionId },
        initSdk: () => sdk,
        retrievalOverride: {
          getTurns: async () => ({
            ok: true,
            value: {
              callId: "fake",
              served: [
                {
                  turnId: "t1",
                  text: "Z".repeat(50_000),
                  tokens: 1000,
                  source: "composed" as const,
                },
              ],
              unserved: [],
              totalTokens: 1000,
              tokenBudget: 8000,
            },
          }),
        },
      }),
    ).rejects.toThrow(/RETRIEVAL_ENVELOPE_INVARIANT/);
    // Adversarial override bypasses SDK writes — documents contract corruption,
    // not the pre-SDK zero-impression acceptance gate.
    expect(await impressions()).toBe(n0);
  });

  /** Counting fake writable: tracks error/drain listeners for leak mutations. */
  function makeCountingWritable(opts: {
    /** write() return value (backpressure). */
    writeReturns: boolean;
    /** When to invoke write callback relative to write return. */
    callbackTiming: "sync-ok" | "sync-err" | "async-ok" | "async-err" | "held";
    /** Emit drain before write returns (custom writable). */
    drainBeforeReturn?: boolean;
    /** Emit drain after write returns (async). */
    drainAfterMs?: number;
    syncErr?: Error;
  }) {
    const listeners = {
      error: new Set<(...a: unknown[]) => void>(),
      drain: new Set<(...a: unknown[]) => void>(),
    };
    let heldCb: ((err?: Error | null) => void) | undefined;
    let writeCalls = 0;
    const stream = {
      write(_data: string, encodingOrCb?: unknown, maybeCb?: unknown) {
        writeCalls += 1;
        const cb =
          typeof encodingOrCb === "function"
            ? (encodingOrCb as (err?: Error | null) => void)
            : typeof maybeCb === "function"
              ? (maybeCb as (err?: Error | null) => void)
              : undefined;
        if (opts.drainBeforeReturn) {
          for (const fn of [...listeners.drain]) fn();
        }
        const fireOk = () => cb?.(null);
        const fireErr = () => cb?.(opts.syncErr ?? new Error("SYNC_WRITE_ERR"));
        switch (opts.callbackTiming) {
          case "sync-ok":
            fireOk();
            break;
          case "sync-err":
            fireErr();
            break;
          case "async-ok":
            setTimeout(fireOk, 5);
            break;
          case "async-err":
            setTimeout(fireErr, 5);
            break;
          case "held":
            heldCb = cb;
            break;
        }
        if (opts.drainAfterMs !== undefined) {
          setTimeout(() => {
            for (const fn of [...listeners.drain]) fn();
          }, opts.drainAfterMs);
        }
        return opts.writeReturns;
      },
      once(ev: string, fn: (...a: unknown[]) => void) {
        if (ev === "error" || ev === "drain") {
          listeners[ev].add(fn);
        }
        return stream;
      },
      on(ev: string, fn: (...a: unknown[]) => void) {
        return stream.once(ev, fn);
      },
      off(ev: string, fn: (...a: unknown[]) => void) {
        if (ev === "error" || ev === "drain") {
          listeners[ev].delete(fn);
        }
        return stream;
      },
      emit(ev: string, ...args: unknown[]) {
        if (ev === "error" || ev === "drain") {
          for (const fn of [...listeners[ev]]) fn(...args);
        }
        return true;
      },
      listenerCount(ev: string) {
        if (ev === "error" || ev === "drain") return listeners[ev].size;
        return 0;
      },
      getHeldCallback() {
        return heldCb;
      },
      getWriteCalls() {
        return writeCalls;
      },
    };
    return stream as unknown as NodeJS.WritableStream & {
      listenerCount(ev: string): number;
      getHeldCallback(): ((err?: Error | null) => void) | undefined;
      emit(ev: string, ...args: unknown[]): boolean;
      getWriteCalls(): number;
    };
  }

  it("writeAll: callback-then-drain resolves only after both", async () => {
    const stream = makeCountingWritable({
      writeReturns: false,
      callbackTiming: "held",
    });
    const p = writeAll(stream, "hello\n");
    let settled = false;
    let err: unknown;
    void p.then(
      () => {
        settled = true;
      },
      (e) => {
        settled = true;
        err = e;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    // Callback first (success)
    stream.getHeldCallback()?.(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    // Then drain
    stream.emit("drain");
    await p;
    expect(settled).toBe(true);
    expect(err).toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);
  });

  it("writeAll: drain-then-callback stays pending until callback; late error rejects", async () => {
    const stream = makeCountingWritable({
      writeReturns: false,
      callbackTiming: "held",
    });
    const p = writeAll(stream, "payload\n");
    let settled = false;
    let rejected: unknown;
    void p.then(
      () => {
        settled = true;
      },
      (e) => {
        settled = true;
        rejected = e;
      },
    );
    // Drain first (Darwin reproduction path)
    stream.emit("drain");
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    // Late callback error must reject even after drain
    stream.getHeldCallback()?.(new Error("LATE_EPIPE"));
    await expect(p).rejects.toThrow(/LATE_EPIPE/);
    expect(settled).toBe(true);
    expect(String(rejected)).toMatch(/LATE_EPIPE/);
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);
  });

  it("writeAll: drain-then-successful-callback resolves", async () => {
    const stream = makeCountingWritable({
      writeReturns: false,
      callbackTiming: "held",
    });
    const p = writeAll(stream, "ok\n");
    stream.emit("drain");
    await new Promise((r) => setTimeout(r, 10));
    stream.getHeldCallback()?.(null);
    await expect(p).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);
  });

  it("writeAll: sync error + return false leaves zero listeners (C9 leak fix)", async () => {
    const stream = makeCountingWritable({
      writeReturns: false,
      callbackTiming: "sync-err",
      syncErr: new Error("SYNC_EPIPE"),
    });
    await expect(writeAll(stream, "x")).rejects.toThrow(/SYNC_EPIPE/);
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);
  });

  it("writeAll: sync ok + return true leaves zero listeners", async () => {
    const stream = makeCountingWritable({
      writeReturns: true,
      callbackTiming: "sync-ok",
    });
    await expect(writeAll(stream, "x")).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);
  });

  it("writeAll: sync ok + return false + drain-before-return resolves", async () => {
    const stream = makeCountingWritable({
      writeReturns: false,
      callbackTiming: "sync-ok",
      drainBeforeReturn: true,
    });
    await expect(writeAll(stream, "x")).resolves.toBeUndefined();
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);
  });

  it("writeAll: sync error + return true leaves zero listeners", async () => {
    const stream = makeCountingWritable({
      writeReturns: true,
      callbackTiming: "sync-err",
      syncErr: new Error("SYNC_TRUE_ERR"),
    });
    await expect(writeAll(stream, "x")).rejects.toThrow(/SYNC_TRUE_ERR/);
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("drain")).toBe(0);
  });

  it("writeAll: repeated sync-error×false never accumulates listeners", async () => {
    const stream = makeCountingWritable({
      writeReturns: false,
      callbackTiming: "sync-err",
      syncErr: new Error("LEAK_PROBE"),
    });
    for (let i = 0; i < 12; i += 1) {
      await expect(writeAll(stream, `p${i}`)).rejects.toThrow(/LEAK_PROBE/);
      expect(stream.listenerCount("error"), `iter ${i} error`).toBe(0);
      expect(stream.listenerCount("drain"), `iter ${i} drain`).toBe(0);
    }
    expect(stream.getWriteCalls()).toBe(12);
  });

  it("writeAll: four sync combinations leave zero listeners after settle", async () => {
    const cases: Array<{
      writeReturns: boolean;
      callbackTiming: "sync-ok" | "sync-err";
      drainBeforeReturn?: boolean;
      expectOk: boolean;
    }> = [
      { writeReturns: true, callbackTiming: "sync-ok", expectOk: true },
      { writeReturns: true, callbackTiming: "sync-err", expectOk: false },
      {
        writeReturns: false,
        callbackTiming: "sync-ok",
        drainBeforeReturn: true,
        expectOk: true,
      },
      { writeReturns: false, callbackTiming: "sync-err", expectOk: false },
    ];
    for (const c of cases) {
      const stream = makeCountingWritable({
        writeReturns: c.writeReturns,
        callbackTiming: c.callbackTiming,
        ...(c.drainBeforeReturn === true ? { drainBeforeReturn: true as const } : {}),
        syncErr: new Error("COMBO_ERR"),
      });
      if (c.expectOk) {
        await expect(writeAll(stream, "z")).resolves.toBeUndefined();
      } else {
        await expect(writeAll(stream, "z")).rejects.toThrow();
      }
      expect(stream.listenerCount("error")).toBe(0);
      expect(stream.listenerCount("drain")).toBe(0);
    }
  });

  it("runRetrievalCli awaits backpressured stdout (does not resolve early)", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let writeCount = 0;
    const chunks: string[] = [];

    const stream = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    stream.write = ((chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown) => {
      const data = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : typeof chunk === "string" ? chunk : String(chunk);
      writeCount += 1;
      chunks.push(data);
      const callback =
        typeof encodingOrCb === "function"
          ? (encodingOrCb as (err?: Error | null) => void)
          : typeof maybeCb === "function"
            ? (maybeCb as (err?: Error | null) => void)
            : undefined;
      gate
        .then(() => {
          if (callback) callback(null);
          stream.emit("drain");
        })
        .catch(() => undefined);
      return false;
    }) as typeof stream.write;

    const sink = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });

    const cliPromise = runRetrievalCli(
      ["get-turns", "t1"],
      { stdout: stream, stderr: sink },
      {
        descriptorPath: descPath,
        descriptorIo: io,
        env: { CLAUDE_CODE_SESSION_ID: sessionId },
        initSdk: () => sdk,
      },
    );

    let settled = false;
    cliPromise
      .then(() => {
        settled = true;
      })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(writeCount).toBeGreaterThanOrEqual(1);

    release!();
    const code = await cliPromise;
    expect(code).toBe(0);
    expect(settled).toBe(true);
    const body = chunks.join("");
    expect(body).toContain("<recalled-history");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("writeAll rejects on stream write error when write returns true", async () => {
    const errStream = {
      write(_data: string, encodingOrCb?: unknown, maybeCb?: unknown) {
        const cb =
          typeof encodingOrCb === "function"
            ? (encodingOrCb as (e?: Error | null) => undefined)
            : typeof maybeCb === "function"
              ? (maybeCb as (e?: Error | null) => undefined)
              : undefined;
        setTimeout(() => {
          if (cb) cb(new Error("EPIPE_TEST"));
        }, 0);
        return true;
      },
      once() {
        return errStream;
      },
      off() {
        return errStream;
      },
      on() {
        return errStream;
      },
    } as unknown as NodeJS.WritableStream;
    await expect(writeAll(errStream, "hello\n")).rejects.toThrow(/EPIPE_TEST/);
  });

  it("two archives: distinguishable content and impressions isolated", async () => {
    const tf2 = join(root, "threads", "t2.sqlite");
    const created2 = await sdk.threads.newThread({ filePath: tf2, registryPath });
    if (!created2.ok) throw new Error(created2.error.reason);
    // Distinct assistant text
    await sdk.intakeStream.messageEvents({ filePath: tf2 }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: "u2",
        actor: "user",
        harness: "cc",
        payload: { text: "archive-B-unique-prompt" },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: "a2",
        actor: "assistant",
        harness: "cc",
        payload: { text: "ARCHIVE_B_UNIQUE_ANSWER_XYZ" },
      },
      {
        eventKind: "turn_end",
        idempotencyKey: "e2",
        actor: "system",
        harness: "cc",
        payload: {},
      },
    ]);
    await sdk.work.drain({ filePath: tf2 });

    const sid2 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const rp2 = join(root, `${sid2}.jsonl`);
    writeRollout(rp2, sid2);
    const path2 = newDescriptorPath(root, io);
    let d2 = createOpeningDescriptor(path2, io);
    d2 = markReady(path2, d2, {
      threadId: created2.value.threadId,
      registryPath,
      sessionId: sid2,
      rolloutPath: rp2,
    });
    void d2;

    const n1before = await impressions();
    const imps2b = await retrieval.listImpressions({ filePath: tf2 });
    expect(imps2b.ok).toBe(true);
    if (!imps2b.ok) return;
    const n2before = imps2b.value.length;

    const r1 = await executeRetrieval(["get-turns", "t1"], {
      descriptorPath: descPath,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sessionId },
      initSdk: () => sdk,
    });
    const r2 = await executeRetrieval(["get-turns", "t1"], {
      descriptorPath: path2,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sid2 },
      initSdk: () => sdk,
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.stdout).not.toContain("ARCHIVE_B_UNIQUE_ANSWER_XYZ");
    expect(r2.stdout).toContain("ARCHIVE_B_UNIQUE_ANSWER_XYZ");
    expect(await impressions()).toBe(n1before + 1);
    const imps2a = await retrieval.listImpressions({ filePath: tf2 });
    expect(imps2a.ok).toBe(true);
    if (!imps2a.ok) return;
    expect(imps2a.value.length).toBe(n2before + 1);
  });
});
