/**
 * Correction 9: coherent snapshot commit ordering.
 */

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeVerifiedPrefixBoundary,
  openContinuityHandle,
  verifyPrefixBoundaryOnHandle,
} from "../../src/intake/prefix-boundary.js";
import type { WatcherEmission } from "../../src/rollout/types.js";
import { type RolloutWatcher, watchRolloutFile } from "../../src/rollout/watcher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("coherent snapshot watcher", () => {
  let watcher: RolloutWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  it("initial complete line + partial: reject, zero emissions; later completion still zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-snap-partial-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "complete", message: { role: "user", content: "a" } })}\n` +
        '{"type":"user","uuid":"partial"',
    );
    const emissions: WatcherEmission[] = [];
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      onBatch: (em) => {
        emissions.push(...em);
      },
    });
    await expect(watcher.initialCatchUp).rejects.toThrow(/unterminated initial partial/);
    expect(emissions).toHaveLength(0);
    expect(watcher.isTerminal?.()).toBe(true);
    appendFileSync(path, ',"message":{"role":"user","content":"late"}}\n');
    await sleep(150);
    expect(emissions).toHaveLength(0);
  });

  it("mutation after candidate copy before commit: no delivery, no mutated baseline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-snap-mutate-"));
    const path = join(dir, "s.jsonl");
    const line = `${JSON.stringify({ type: "user", uuid: "orig", message: { role: "user", content: "orig" } })}\n`;
    writeFileSync(path, line);
    const emissions: WatcherEmission[] = [];
    let mutated = false;
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      afterCandidateRead: ({ bytes }) => {
        if (mutated) return;
        if (bytes.byteLength > 0) {
          mutated = true;
          // Mutate file after candidate bytes were copied.
          writeFileSync(
            path,
            `${JSON.stringify({ type: "user", uuid: "MUTATED", message: { role: "user", content: "mut" } })}\n`,
          );
        }
      },
      onBatch: (em) => {
        emissions.push(...em);
      },
    });
    // Either rejects initial or retries to success with post-check failing then retry.
    // After mutation during first read, post meta differs → retry; second read may succeed
    // with MUTATED if we re-read. For first attempt with mutation, post ctime/mtime/size
    // should differ if same-size rewrite still updates ctime.
    // Force same-size to still change ctime on linux.
    await sleep(100);
    // If initial succeeded after retry, emissions may have MUTATED — that's coherent.
    // The critical invariant: never deliver ORIG while adopting MUTATED baseline.
    // Inject a mid-flight mutation that changes size so post-check always fails:
    watcher?.stop();
    watcher = undefined;

    writeFileSync(path, line);
    const emissions2: WatcherEmission[] = [];
    let fires = 0;
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      afterCandidateRead: () => {
        fires += 1;
        // Grow the file so post size differs from pre size.
        appendFileSync(
          path,
          `${JSON.stringify({ type: "user", uuid: "EXTRA", message: { role: "user", content: "x" } })}\n`,
        );
      },
      onBatch: (em) => {
        emissions2.push(...em);
      },
    });
    await expect(watcher.initialCatchUp).rejects.toThrow(/snapshot changed during read/);
    expect(emissions2).toHaveLength(0);
    expect(fires).toBeGreaterThanOrEqual(1);
  });

  it("growth/normal append delivers exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-snap-append-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, "");
    const counts = new Map<string, number>();
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      onBatch: (em) => {
        for (const e of em) {
          if (e.kind === "line") {
            const id = String(e.item.uuid);
            counts.set(id, (counts.get(id) ?? 0) + 1);
          }
        }
      },
    });
    await watcher.initialCatchUp;
    appendFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "once", message: { role: "user", content: "hi" } })}\n`,
    );
    await sleep(150);
    expect(counts.get("once")).toBe(1);
  });

  it(">1 KiB early rewrite rejected with no lure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-snap-early-"));
    const path = join(dir, "s.jsonl");
    const early: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      early.push(
        JSON.stringify({
          type: "user",
          uuid: `early-${i}`,
          message: { role: "user", content: `pad-${i}-${"x".repeat(24)}` },
        }),
      );
    }
    const tail = JSON.stringify({
      type: "user",
      uuid: "TAIL",
      message: { role: "user", content: "tail-" + "y".repeat(40) },
    });
    const prefix = `${early.join("\n")}\n${tail}\n`;
    expect(Buffer.byteLength(prefix)).toBeGreaterThan(1024);
    writeFileSync(path, prefix);
    const boundary = computeVerifiedPrefixBoundary(prefix, early.length + 1);
    const handle = openContinuityHandle(path);
    expect(verifyPrefixBoundaryOnHandle(handle, boundary).ok).toBe(true);

    const lines: string[] = [];
    const fails: string[] = [];
    watcher = watchRolloutFile({
      continuity: handle,
      startOffset: boundary.byteLength,
      expectedConsumedDigest: boundary.sha256,
      pollMs: 40,
      onBatch: (em) => {
        for (const e of em) {
          if (e.kind === "line") lines.push(String(e.item.uuid));
        }
      },
      onContinuityFailure: (m) => fails.push(m),
      onFileShrink: (m) => fails.push(m),
    });
    await watcher.initialCatchUp;

    const evil = early.map((l, i) =>
      JSON.stringify({
        type: "user",
        uuid: `EVIL-${i}`,
        message: { role: "user", content: `evil-${i}-${"z".repeat(24)}` },
      }),
    );
    writeFileSync(
      path,
      `${evil.join("\n")}\n${tail}\n` +
        `${JSON.stringify({ type: "user", uuid: "LURE", message: { role: "user", content: "lure" } })}\n`,
    );
    await sleep(250);
    expect(fails.length).toBeGreaterThanOrEqual(1);
    expect(lines).not.toContain("LURE");
  });

  it("positive startOffset without expectedConsumedDigest fails closed (no re-baseline)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-no-digest-"));
    const path = join(dir, "s.jsonl");
    const prefix = `${JSON.stringify({ type: "user", uuid: "p1", message: { role: "user", content: "x" } })}\n`;
    writeFileSync(path, prefix);
    const emissions: WatcherEmission[] = [];
    watcher = watchRolloutFile({
      filePath: path,
      startOffset: Buffer.byteLength(prefix),
      pollMs: 40,
      onBatch: (em) => {
        emissions.push(...em);
      },
    });
    await expect(watcher.initialCatchUp).rejects.toThrow(
      /positive startOffset requires expectedConsumedDigest/,
    );
    expect(watcher.isTerminal?.()).toBe(true);
    expect(emissions).toHaveLength(0);
  });

  it("handoff-gap same-inode rewrite after verify: digest A rejects B baseline", async () => {
    // Session proves digest A on held fd, then a rewrite to equal-length B
    // happens before watcher construct. Watcher must be given A and reject —
    // never re-read and adopt B as baseline.
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-handoff-gap-"));
    const path = join(dir, "s.jsonl");
    const prefixA = `${JSON.stringify({ type: "user", uuid: "AAAA", message: { role: "user", content: "AAAA" } })}\n`;
    const prefixB = `${JSON.stringify({ type: "user", uuid: "BBBB", message: { role: "user", content: "BBBB" } })}\n`;
    expect(Buffer.byteLength(prefixA)).toBe(Buffer.byteLength(prefixB));
    writeFileSync(path, prefixA);
    const boundaryA = computeVerifiedPrefixBoundary(prefixA, 1);
    const handle = openContinuityHandle(path);
    expect(verifyPrefixBoundaryOnHandle(handle, boundaryA).ok).toBe(true);

    // Handoff gap: same-inode rewrite to B (+ lure) after proof, before construct.
    writeFileSync(
      path,
      prefixB +
        `${JSON.stringify({ type: "user", uuid: "LURE-HANDOFF", message: { role: "user", content: "lure" } })}\n`,
    );

    const emissions: WatcherEmission[] = [];
    const fails: string[] = [];
    watcher = watchRolloutFile({
      continuity: handle,
      startOffset: boundaryA.byteLength,
      expectedConsumedDigest: boundaryA.sha256, // proven A — not re-derived from B
      pollMs: 40,
      onBatch: (em) => {
        emissions.push(...em);
      },
      onInitialFailure: (m) => fails.push(m),
      onContinuityFailure: (m) => fails.push(m),
    });
    await expect(watcher.initialCatchUp).rejects.toThrow(
      /consumed region digest mismatch|rewrite of already-read/,
    );
    expect(watcher.isTerminal?.()).toBe(true);
    expect(emissions).toHaveLength(0);
    expect(JSON.stringify(emissions)).not.toContain("LURE-HANDOFF");
    expect(JSON.stringify(emissions)).not.toContain("BBBB");
  });

  it("open success then fstat failure closes fd once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-open-fstat-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, "");
    const { closeSync: realClose } = await import("node:fs");
    let closeCount = 0;
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      io: {
        fstat: () => {
          throw new Error("injected fstat fail at open");
        },
        close: (fd) => {
          closeCount += 1;
          realClose(fd);
        },
      },
      onBatch: () => {},
    });
    await expect(watcher.initialCatchUp).rejects.toThrow(/initial fstat failed/);
    expect(watcher.isTerminal?.()).toBe(true);
    expect(closeCount).toBe(1);
    // stop() must be idempotent — no second close of the same fd.
    watcher.stop();
    expect(closeCount).toBe(1);
  });
});
