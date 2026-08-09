/**
 * Correction 8: exact consumed-region continuity + terminal initial failures.
 */

import { appendFileSync, mkdtempSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeVerifiedPrefixBoundary,
  openContinuityHandle,
  verifyPrefixBoundaryOnHandle,
} from "../../src/intake/prefix-boundary.js";
import type { WatcherEmission } from "../../src/rollout/types.js";
import { type RolloutWatcher, type WatcherIo, watchRolloutFile } from "../../src/rollout/watcher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("watcher continuity (exact consumed digest)", () => {
  let watcher: RolloutWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  it("normal append after verified prefix continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cont-ok-"));
    const path = join(dir, "s.jsonl");
    const prefix = `${JSON.stringify({ type: "user", uuid: "p1", message: { role: "user", content: "pfx" } })}\n`;
    writeFileSync(path, prefix);
    const boundary = computeVerifiedPrefixBoundary(prefix, 1);
    const handle = openContinuityHandle(path);
    expect(verifyPrefixBoundaryOnHandle(handle, boundary).ok).toBe(true);

    const lines: string[] = [];
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
    });
    await watcher.initialCatchUp;
    appendFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "live1", message: { role: "user", content: "ok" } })}\n`,
    );
    await sleep(150);
    expect(lines).toContain("live1");
  });

  it("path replacement after proof degrades and does not ingest lure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cont-replace-"));
    const path = join(dir, "s.jsonl");
    const alt = join(dir, "s-alt.jsonl");
    const prefix = `${JSON.stringify({ type: "user", uuid: "p1", message: { role: "user", content: "pfx" } })}\n`;
    writeFileSync(path, prefix);
    const boundary = computeVerifiedPrefixBoundary(prefix, 1);
    const handle = openContinuityHandle(path);
    expect(verifyPrefixBoundaryOnHandle(handle, boundary).ok).toBe(true);

    const lines: string[] = [];
    const cont: string[] = [];
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
      onContinuityFailure: (m) => cont.push(m),
    });
    await watcher.initialCatchUp;

    // Replace path only after ready — must not follow new inode lure.
    writeFileSync(
      alt,
      prefix +
        `${JSON.stringify({ type: "user", uuid: "LURE", message: { role: "user", content: "lure-path-replace" } })}\n`,
    );
    renameSync(alt, path);
    await sleep(200);
    expect(cont.length).toBeGreaterThanOrEqual(1);
    expect(lines).not.toContain("LURE");
  });

  it(">1 KiB consumed prefix: rewrite early bytes only (final 256 identical) then lure — degrades", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cont-early-"));
    const path = join(dir, "s.jsonl");
    // Build >1 KiB of prefix lines with a stable tail block.
    const early: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      early.push(
        JSON.stringify({
          type: "user",
          uuid: `early-${i.toString().padStart(3, "0")}`,
          message: { role: "user", content: `early-content-pad-${i}-${"x".repeat(20)}` },
        }),
      );
    }
    const tail = JSON.stringify({
      type: "user",
      uuid: "TAIL-STABLE-BLOCK-256-BYTES-AAAA",
      message: { role: "user", content: "stable-tail-" + "y".repeat(80) },
    });
    const prefix = `${early.join("\n")}\n${tail}\n`;
    expect(Buffer.byteLength(prefix, "utf8")).toBeGreaterThan(1024);
    writeFileSync(path, prefix);
    const boundary = computeVerifiedPrefixBoundary(prefix, early.length + 1);
    const handle = openContinuityHandle(path);
    expect(verifyPrefixBoundaryOnHandle(handle, boundary).ok).toBe(true);

    const lines: string[] = [];
    const cont: string[] = [];
    const shrinks: string[] = [];
    watcher = watchRolloutFile({
      continuity: handle,
      startOffset: boundary.byteLength,
      expectedConsumedDigest: boundary.sha256,
      pollMs: 40,
      onBatch: (em: WatcherEmission[]) => {
        for (const e of em) {
          if (e.kind === "line") lines.push(String(e.item.uuid));
        }
      },
      onContinuityFailure: (m) => cont.push(m),
      onFileShrink: (m) => shrinks.push(m),
    });
    await watcher.initialCatchUp;

    // Rewrite only early lines while keeping the final tail line text identical.
    // Full-region digest must fail (or shrink if length drops below offset).
    const evilEarly: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      evilEarly.push(
        JSON.stringify({
          type: "user",
          uuid: `EVIL-${i.toString().padStart(3, "0")}`,
          message: { role: "user", content: `evil-content-pad-${i}-${"z".repeat(20)}` },
        }),
      );
    }
    writeFileSync(
      path,
      `${evilEarly.join("\n")}\n${tail}\n` +
        `${JSON.stringify({ type: "user", uuid: "LURE-EARLY", message: { role: "user", content: "lure" } })}\n`,
    );
    await sleep(250);
    expect(cont.length + shrinks.length).toBeGreaterThanOrEqual(1);
    expect(lines).not.toContain("LURE-EARLY");
  });

  it("same-size rewrite of consumed region then append degrades without lure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cont-rewrite-"));
    const path = join(dir, "s.jsonl");
    const lineA = `${JSON.stringify({ type: "user", uuid: "AAAA", message: { role: "user", content: "AAAA" } })}\n`;
    const lineB = `${JSON.stringify({ type: "user", uuid: "BBBB", message: { role: "user", content: "BBBB" } })}\n`;
    writeFileSync(path, lineA + lineB);
    const boundary = computeVerifiedPrefixBoundary(lineA + lineB, 2);
    const handle = openContinuityHandle(path);
    expect(verifyPrefixBoundaryOnHandle(handle, boundary).ok).toBe(true);

    const lines: string[] = [];
    const cont: string[] = [];
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
      onContinuityFailure: (m) => cont.push(m),
    });
    await watcher.initialCatchUp;

    const lineA2 = `${JSON.stringify({ type: "user", uuid: "CCCC", message: { role: "user", content: "CCCC" } })}\n`;
    const lineB2 = `${JSON.stringify({ type: "user", uuid: "DDDD", message: { role: "user", content: "DDDD" } })}\n`;
    writeFileSync(
      path,
      lineA2 +
        lineB2 +
        `${JSON.stringify({ type: "user", uuid: "LURE2", message: { role: "user", content: "lure-rewrite" } })}\n`,
    );
    await sleep(200);
    expect(cont.length).toBeGreaterThanOrEqual(1);
    expect(lines).not.toContain("LURE2");
  });

  it("truncate-and-regrow with altered prefix degrades without lure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-cont-regrow-"));
    const path = join(dir, "s.jsonl");
    const prefix = `${JSON.stringify({ type: "user", uuid: "p1", message: { role: "user", content: "prefix-long-enough-xxxx" } })}\n`;
    writeFileSync(path, prefix);
    const boundary = computeVerifiedPrefixBoundary(prefix, 1);
    const handle = openContinuityHandle(path);
    expect(verifyPrefixBoundaryOnHandle(handle, boundary).ok).toBe(true);

    const lines: string[] = [];
    const cont: string[] = [];
    const shrinks: string[] = [];
    watcher = watchRolloutFile({
      continuity: handle,
      startOffset: boundary.byteLength,
      expectedConsumedDigest: boundary.sha256,
      pollMs: 200,
      onBatch: (em) => {
        for (const e of em) {
          if (e.kind === "line") lines.push(String(e.item.uuid));
        }
      },
      onContinuityFailure: (m) => cont.push(m),
      onFileShrink: (m) => shrinks.push(m),
    });
    await watcher.initialCatchUp;

    const evilPrefix = `${JSON.stringify({ type: "user", uuid: "pZ", message: { role: "user", content: "prefix-ALTERED-enough-yyyy" } })}\n`;
    writeFileSync(path, "");
    writeFileSync(
      path,
      evilPrefix +
        `${JSON.stringify({ type: "user", uuid: "LURE3", message: { role: "user", content: "lure-regrow" } })}\n`,
    );
    await sleep(400);
    expect(cont.length + shrinks.length).toBeGreaterThanOrEqual(1);
    expect(lines).not.toContain("LURE3");
  });

  it("unterminated initial content is terminal: append later yields zero emissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-partial-init-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, '{"type":"user","uuid":"partial"'); // no newline
    const emissions: WatcherEmission[] = [];
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      onBatch: (em) => {
        emissions.push(...em);
      },
    });
    await expect(watcher.initialCatchUp).rejects.toThrow(/unterminated initial partial/);
    expect(watcher.isTerminal?.()).toBe(true);
    appendFileSync(path, ',"message":{"role":"user","content":"late"}}\n');
    await sleep(150);
    expect(emissions).toHaveLength(0);
  });

  it("positive short reads eventually complete successfully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-short-ok-"));
    const path = join(dir, "s.jsonl");
    const line = `${JSON.stringify({ type: "user", uuid: "ok1", message: { role: "user", content: "hi" } })}\n`;
    writeFileSync(path, line);
    let call = 0;
    const realRead = (await import("node:fs")).readSync;
    const io: Partial<WatcherIo> = {
      read: (fd, buffer, offset, length, position) => {
        call += 1;
        // First two reads return 1 byte; then full.
        if (call <= 2 && length > 1) {
          return realRead(fd, buffer, offset, 1, position);
        }
        return realRead(fd, buffer, offset, length, position);
      },
    };
    const uuids: string[] = [];
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      io,
      onBatch: (em) => {
        for (const e of em) {
          if (e.kind === "line") uuids.push(String(e.item.uuid));
        }
      },
    });
    await watcher.initialCatchUp;
    expect(uuids).toContain("ok1");
  });

  it("positive short read then zero is terminal and commits no offset (append yields zero)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-short-zero-"));
    const path = join(dir, "s.jsonl");
    const line = `${JSON.stringify({ type: "user", uuid: "bad1", message: { role: "user", content: "x" } })}\n`;
    writeFileSync(path, line);
    let call = 0;
    const realRead = (await import("node:fs")).readSync;
    const io: Partial<WatcherIo> = {
      read: (fd, buffer, offset, length, position) => {
        call += 1;
        if (call === 1) return realRead(fd, buffer, offset, 1, position);
        return 0; // then zero
      },
    };
    const emissions: WatcherEmission[] = [];
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      io,
      onBatch: (em) => {
        emissions.push(...em);
      },
    });
    await expect(watcher.initialCatchUp).rejects.toThrow(/short read/);
    expect(watcher.isTerminal?.()).toBe(true);
    appendFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "after-fail", message: { role: "user", content: "nope" } })}\n`,
    );
    await sleep(150);
    expect(emissions).toHaveLength(0);
  });

  it("post-ready fstat failure: exactly one runtime callback, no later delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-runtime-fstat-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, "");
    let failStat = false;
    let statCalls = 0;
    const realFstat = (await import("node:fs")).fstatSync;
    const io: Partial<WatcherIo> = {
      fstat: (fd) => {
        statCalls += 1;
        if (failStat) throw new Error("injected fstat fail");
        const st = realFstat(fd);
        return { size: st.size, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
      },
    };
    const runtimes: string[] = [];
    const emissions: WatcherEmission[] = [];
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      io,
      onBatch: (em) => {
        emissions.push(...em);
      },
      onRuntimeFailure: (m) => runtimes.push(m),
    });
    await watcher.initialCatchUp;
    failStat = true;
    await sleep(150);
    expect(runtimes).toHaveLength(1);
    appendFileSync(
      path,
      `${JSON.stringify({ type: "user", uuid: "late", message: { role: "user", content: "x" } })}\n`,
    );
    await sleep(150);
    expect(runtimes).toHaveLength(1);
    expect(emissions.filter((e) => e.kind === "line" && e.item.uuid === "late")).toHaveLength(0);
    void statCalls;
  });
});
