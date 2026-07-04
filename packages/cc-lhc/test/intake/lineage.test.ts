import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendThreadSignatures,
  emptyLineageFile,
  lineageTempPath,
  loadLineageFile,
  lookupThreadForSession,
  newestSessionEntry,
  recordSessionThread,
  resolveCaptureThread,
  saveLineageFile,
  tryContinueThreadFromNewestSession,
} from "../../src/intake/lineage.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";

describe("lineage map", () => {
  it("writes atomically via tmp+rename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-"));
    const mapPath = join(dir, "cc-sessions.json");
    await recordSessionThread(mapPath, "session-a", "th_1");
    const loaded = await loadLineageFile(mapPath);
    expect(lookupThreadForSession(loaded, "session-a")).toBe("th_1");
    const parsed = JSON.parse(readFileSync(mapPath, "utf8")) as { version: number };
    expect(parsed.version).toBe(1);
  });

  it("tolerates a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-missing-"));
    const loaded = await loadLineageFile(join(dir, "missing.json"));
    expect(loaded).toEqual(emptyLineageFile());
  });

  it("renames corrupt files aside and starts fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-corrupt-"));
    const mapPath = join(dir, "cc-sessions.json");
    writeFileSync(mapPath, "{not json");
    const loaded = await loadLineageFile(mapPath);
    expect(loaded).toEqual(emptyLineageFile());
    expect(readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("resolves resume-arg lookup through the old session id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-resume-"));
    const mapPath = join(dir, "cc-sessions.json");
    await recordSessionThread(mapPath, "old-session", "th_resume");

    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: "new-session",
      cwd: "/work/project",
      resumeSessionId: "old-session",
      lineagePath: mapPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_new" } };
      },
    });

    expect(created).toBe(0);
    expect(resolution.threadRef).toEqual({ threadId: "th_resume" });
    expect(resolution.isExistingThread).toBe(true);
    expect(lookupThreadForSession(await loadLineageFile(mapPath), "new-session")).toBe("th_resume");
  });

  it("creates a thread on map miss and records the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-miss-"));
    const mapPath = join(dir, "cc-sessions.json");
    let created = 0;
    const errors: string[] = [];
    const resolution = await resolveCaptureThread({
      sessionId: "fresh-session",
      cwd: "/work/project",
      lineagePath: mapPath,
      logError: (message) => errors.push(message),
      lineageDeps: {
        writeFileFn: async () => {
          throw new Error("disk full");
        },
      },
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_fresh" } };
      },
    });

    expect(created).toBe(1);
    expect(resolution.isExistingThread).toBe(false);
    expect(resolution.threadRef).toEqual({ threadId: "th_fresh" });
    expect(errors.some((line) => line.includes("lineage write failed (continuing)"))).toBe(true);
  });

  it("reuses a mapped thread on hit without creating a new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-hit-"));
    const mapPath = join(dir, "cc-sessions.json");
    await recordSessionThread(mapPath, "session-hit", "th_hit");
    let created = 0;
    const resolution = await resolveCaptureThread({
      sessionId: "session-hit",
      cwd: "/work/project",
      lineagePath: mapPath,
      createThreadFn: async () => {
        created += 1;
        return { ok: true, value: { threadId: "th_other" } };
      },
    });
    expect(created).toBe(0);
    expect(resolution.threadRef).toEqual({ threadId: "th_hit" });
  });

  it("continues via --continue when newest map entry matches newest jsonl", async () => {
    const root = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-continue-"));
    const mapPath = join(root, "cc-sessions.json");
    const cwd = "/work/continue";
    const projectDir = join(root, encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const sessionId = "continue-session";
    const rolloutPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(rolloutPath, '{"type":"user"}\n');
    await recordSessionThread(mapPath, sessionId, "th_continue");

    const continued = await tryContinueThreadFromNewestSession(
      await loadLineageFile(mapPath),
      cwd,
      root,
      {
        readdirFn: (async () => [`${sessionId}.jsonl`]) as unknown as typeof import("node:fs/promises").readdir,
        statFn: async () => ({ mtimeMs: Date.now() }) as never,
      },
    );
    expect(continued).toEqual({ sessionId, threadId: "th_continue" });
  });

  it("trims signature caches to the last 500 entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-sigs-"));
    const mapPath = join(dir, "cc-sessions.json");
    const initial = Array.from({ length: 499 }, (_, index) => `sig-${index}`);
    await appendThreadSignatures(mapPath, "th_1", initial);
    await appendThreadSignatures(mapPath, "th_1", ["sig-new-a", "sig-new-b"]);
    const loaded = await loadLineageFile(mapPath);
    expect(loaded.signatures.th_1?.length).toBe(500);
    const overflow = Array.from({ length: 10 }, (_, index) => `overflow-${index}`);
    await appendThreadSignatures(mapPath, "th_1", overflow);
    const trimmed = await loadLineageFile(mapPath);
    expect(trimmed.signatures.th_1?.length).toBe(500);
    expect(trimmed.signatures.th_1?.at(-1)).toBe("overflow-9");
  });

  it("uses unique temp paths for concurrent writes", () => {
    const a = lineageTempPath("/tmp/cc-sessions.json");
    const b = lineageTempPath("/tmp/cc-sessions.json");
    expect(a).not.toBe(b);
  });

  it("picks the newest session entry by updatedAt", async () => {
    const file = emptyLineageFile();
    file.sessions.a = { threadId: "th_a", updatedAt: "2026-07-01T00:00:00.000Z" };
    file.sessions.b = { threadId: "th_b", updatedAt: "2026-07-04T00:00:00.000Z" };
    expect(newestSessionEntry(file)?.sessionId).toBe("b");
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-lineage-save-"));
    const mapPath = join(dir, "cc-sessions.json");
    await saveLineageFile(mapPath, file);
    expect(await loadLineageFile(mapPath)).toEqual(file);
  });
});
