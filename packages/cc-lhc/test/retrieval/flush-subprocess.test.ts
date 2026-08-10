/**
 * Subprocess flush-safety: near-ceiling multibyte retrieval stdout must match
 * in-process executeRetrieval byte-for-byte when the CLI exits via exitCode.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeterministicInferenceCallbacks, initLhc } from "lhc";
import { describe, expect, it } from "vitest";
import { executeRetrieval } from "../../src/retrieval/service.js";
import {
  createOpeningDescriptor,
  type DescriptorIo,
  markReady,
  newDescriptorPath,
  RUNTIME_DESCRIPTOR_ENV,
} from "../../src/runtime/descriptor.js";
import { selfOnlyProbe } from "../helpers/identity.js";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "../fixtures/retrieval-flush-worker.ts");
const tsxBin = join(here, "../../node_modules/.bin/tsx");

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

describe("retrieval CLI flush subprocess", () => {
  it("near-ceiling multibyte stdout matches in-process and is not truncated", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-flush-"));
    const threads = join(root, "threads");
    mkdirSync(threads, { recursive: true });
    const registryPath = join(root, "registry.sqlite");
    const tf = join(threads, "t.sqlite");
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });
    const created = await sdk.threads.newThread({ filePath: tf, registryPath });
    if (!created.ok) throw new Error(created.error.reason);
    // Dense multibyte body → large but under ceiling when retrieved alone
    const big = "運用記録 日本語 🔧 ".repeat(900);
    await sdk.intakeStream.messageEvents({ filePath: tf }, [
      {
        eventKind: "user_prompt",
        idempotencyKey: `u-${Math.random()}`,
        actor: "user",
        harness: "cc",
        payload: { text: big },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: `a-${Math.random()}`,
        actor: "assistant",
        harness: "cc",
        payload: { text: "ack" },
      },
      {
        eventKind: "turn_end",
        idempotencyKey: `e-${Math.random()}`,
        actor: "system",
        harness: "cc",
        payload: {},
      },
    ]);
    await sdk.work.drain({ filePath: tf });

    const sid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const rp = join(root, `${sid}.jsonl`);
    writeFileSync(
      rp,
      JSON.stringify({ type: "user", sessionId: sid, message: { role: "user", content: "hi" } }) + "\n",
    );
    const io = realIo();
    const dp = newDescriptorPath(root, io);
    let d = createOpeningDescriptor(dp, io);
    d = markReady(dp, d, {
      threadId: created.value.threadId,
      registryPath,
      sessionId: sid,
      rolloutPath: rp,
    });
    void d;

    const expected = await executeRetrieval(["get-turns", "t1"], {
      descriptorPath: dp,
      descriptorIo: io,
      env: { CLAUDE_CODE_SESSION_ID: sid },
      initSdk: () => sdk,
    });
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const expectedBytes = Buffer.byteLength(
      expected.stdout.endsWith("\n") ? expected.stdout : `${expected.stdout}\n`,
      "utf8",
    );
    expect(expectedBytes).toBeGreaterThan(8_000);
    expect(expectedBytes).toBeLessThanOrEqual(24_000);

    const child = spawn(tsxBin, [worker], {
      env: {
        ...process.env,
        [RUNTIME_DESCRIPTOR_ENV]: dp,
        CLAUDE_CODE_SESSION_ID: sid,
        WORKER_OP: "get-turns",
        WORKER_IDS: "t1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    const code = await new Promise<number>((resolve) => {
      child.on("close", (c) => resolve(c ?? 1));
    });
    const stdout = Buffer.concat(chunks);
    const stderr = Buffer.concat(errChunks).toString("utf8");
    expect(code, stderr).toBe(0);
    expect(stdout.byteLength).toBe(expectedBytes);
    expect(stdout.toString("utf8")).toBe(expected.stdout.endsWith("\n") ? expected.stdout : `${expected.stdout}\n`);
    // Multibyte intact (no U+FFFD truncation artifact at end of body window)
    expect(stdout.includes(Buffer.from("運用記録", "utf8"))).toBe(true);
  }, 60_000);
});
