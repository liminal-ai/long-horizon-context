import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openLaunchThread } from "../../src/intake/launch-thread.js";
import { recordPendingCurrentSession, recordSessionThread } from "../../src/intake/lineage-db.js";
import { acceptCurrentSession, bindLaunchThread } from "../../src/intake/thread-alias.js";
import { abandonedRebuildsDir } from "../../src/rollout/abandoned-rebuilds.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import { type DescriptorIo, defaultDescriptorIo, sweepStaleRuntimeDescriptors } from "../../src/runtime/descriptor.js";
import type { ProbeProcessIdentity, ProcessIdentity } from "../../src/runtime/process-identity.js";
import { threadOwnerPath } from "../../src/runtime/thread-owner.js";
import { runLaunchSweep } from "../../src/wrapper/launch-sweep.js";
import { aliveResult, indeterminateResult, notFoundResult, syntheticIdentity } from "../helpers/identity.js";

const LIVE = syntheticIdentity(4_100_001);
const DEAD = syntheticIdentity(4_100_002);
const UNKNOWN = syntheticIdentity(4_100_003);
const REUSED = syntheticIdentity(4_100_004);

const probe: ProbeProcessIdentity = (pid) => {
  if (pid === LIVE.pid) return aliveResult(LIVE);
  if (pid === UNKNOWN.pid) return indeterminateResult("access denied");
  if (pid === REUSED.pid) return aliveResult({ ...REUSED, starttime: "7" });
  return notFoundResult(pid);
};

function io(): DescriptorIo {
  return { ...defaultDescriptorIo(), readProcessIdentity: probe };
}

function writeDescriptorFile(home: string, name: string, identity: ProcessIdentity, sessionId?: string): string {
  const dir = join(home, "runtime");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      state: "ready",
      incarnation: `${identity.pid}-1-abcdefgh`,
      wrapperPid: identity.pid,
      wrapperStartedAtMs: 1,
      processIdentity: identity,
      updatedAt: new Date().toISOString(),
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
  );
  return path;
}

function writeOwnerLease(home: string, threadId: string, identity: ProcessIdentity): void {
  const path = threadOwnerPath(threadId, home);
  mkdirSync(join(home, "owners"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, threadId, token: "tok", processIdentity: identity, acquiredAt: "x" })}\n`,
  );
}

const VERIFIED = { kind: "verified" as const, lineCount: 2, byteLength: 40, sha256: "cd".repeat(32) };
const HOUR_AGO = Date.now() / 1000 - 3600;

interface Fixture {
  home: string;
  projectsRoot: string;
  cwd: string;
  projectDir: string;
  registryPath: string;
  lineageDbPath: string;
}

async function fixture(label: string): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), `cc-lhc-sweep-${label}-`));
  const projectsRoot = join(home, "projects");
  const cwd = "/work/proj";
  const projectDir = join(projectsRoot, encodeProjectPath(cwd));
  mkdirSync(projectDir, { recursive: true });
  const f = {
    home,
    projectsRoot,
    cwd,
    projectDir,
    registryPath: join(home, "registry.sqlite"),
    lineageDbPath: join(home, "cc-lhc.sqlite"),
  };
  // Thread th_a: original s-orig, then accepted rebuild s-accepted (current).
  await bindLaunchThread({
    sessionId: "s-orig",
    registryPath: f.registryPath,
    lineageDbPath: f.lineageDbPath,
    createThread: async () => "th_a",
  });
  await acceptCurrentSession({ sessionId: "s-accepted", threadId: "th_a", registryPath: f.registryPath });
  recordSessionThread(f.lineageDbPath, "s-orig", "th_a", {}, { prefix: { kind: "none" } });
  recordSessionThread(f.lineageDbPath, "s-accepted", "th_a", {}, { prefix: VERIFIED });
  return f;
}

function writeSession(f: Fixture, sessionId: string, mtimeSec = HOUR_AGO): string {
  const path = join(f.projectDir, `${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "user", sessionId })}\n`);
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

function writeIndex(f: Fixture, sessionIds: string[]): void {
  writeFileSync(
    join(f.projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: sessionIds.map((sessionId) => ({ sessionId, fullPath: "x" })) }),
  );
}

function indexIds(f: Fixture): string[] {
  const index = JSON.parse(readFileSync(join(f.projectDir, "sessions-index.json"), "utf8")) as {
    entries: Array<{ sessionId: string }>;
  };
  return index.entries.map((entry) => entry.sessionId);
}

function logSink(): { lines: string[]; info(m: string): void; warn(m: string): void } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) };
}

async function sweep(f: Fixture, log = logSink()) {
  const result = await runLaunchSweep({
    home: f.home,
    cwd: f.cwd,
    registryPath: f.registryPath,
    lineageDbPath: f.lineageDbPath,
    projectsRoot: f.projectsRoot,
    descriptorIo: io(),
    log,
  });
  return { result, log };
}

describe("launch sweep: runtime descriptors", () => {
  it("deletes descriptors whose owner is proven gone; keeps live and indeterminate", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-sweep-desc-"));
    const dead = writeDescriptorFile(home, "dead", DEAD);
    const reused = writeDescriptorFile(home, "reused", REUSED);
    const live = writeDescriptorFile(home, "live", LIVE, "s-live");
    const unknown = writeDescriptorFile(home, "unknown", UNKNOWN, "s-unknown");
    const malformed = join(home, "runtime", "garbage.json");
    writeFileSync(malformed, "{not json");
    const temp = join(home, "runtime", ".inflight.tmp");
    writeFileSync(temp, "{}");

    const result = sweepStaleRuntimeDescriptors(home, io());

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(reused)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(malformed)).toBe(true);
    expect(existsSync(temp)).toBe(true);
    expect(result.removed.sort()).toEqual([dead, reused].sort());
    expect(result.keptLive).toBe(1);
    expect(result.keptIndeterminate).toBe(2);
    expect([...result.keptSessionIds].sort()).toEqual(["s-live", "s-unknown"]);
  });
});

describe("launch sweep: abandoned rebuilt transcripts", () => {
  it("moves an abandoned rebuild aside, drops its sessions-index entry, and logs one summary", async () => {
    const f = await fixture("move");
    recordSessionThread(f.lineageDbPath, "s-abandoned", "th_a", {}, { prefix: VERIFIED });
    const path = writeSession(f, "s-abandoned");
    writeSession(f, "s-orig");
    writeSession(f, "s-accepted");
    writeIndex(f, ["s-orig", "s-abandoned", "s-accepted"]);
    writeOwnerLease(f.home, "th_a", DEAD);

    const { result, log } = await sweep(f);

    const moved = join(abandonedRebuildsDir(f.home, f.cwd), "s-abandoned.jsonl");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(moved, "utf8")).toContain("s-abandoned");
    expect(indexIds(f)).toEqual(["s-orig", "s-accepted"]);
    expect(existsSync(join(f.projectDir, "s-orig.jsonl"))).toBe(true);
    expect(existsSync(join(f.projectDir, "s-accepted.jsonl"))).toBe(true);
    expect(result?.rebuilds).toMatchObject({ moved: [{ sessionId: "s-abandoned", indexEntriesRemoved: 1 }] });
    const summaries = log.lines.filter((line) => line.startsWith("info cc-lhc launch sweep: descriptors removed"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("rebuilds moved 1");
  });

  it("leaves the current session and any registry alias untouched", async () => {
    const f = await fixture("alias");
    // s-older-rebuild: accepted earlier, since superseded — still an alias.
    recordSessionThread(f.lineageDbPath, "s-older-rebuild", "th_a", {}, { prefix: VERIFIED });
    await acceptCurrentSession({ sessionId: "s-older-rebuild", threadId: "th_a", registryPath: f.registryPath });
    await acceptCurrentSession({ sessionId: "s-accepted", threadId: "th_a", registryPath: f.registryPath });
    const current = writeSession(f, "s-accepted");
    const alias = writeSession(f, "s-older-rebuild");
    writeIndex(f, ["s-accepted", "s-older-rebuild"]);

    const { result } = await sweep(f);

    expect(existsSync(current)).toBe(true);
    expect(existsSync(alias)).toBe(true);
    expect(indexIds(f)).toEqual(["s-accepted", "s-older-rebuild"]);
    expect(result?.rebuilds).toMatchObject({ moved: [] });
  });

  it("leaves a young rebuild (possible in-flight handoff) untouched", async () => {
    const f = await fixture("young");
    recordSessionThread(f.lineageDbPath, "s-young", "th_a", {}, { prefix: VERIFIED });
    const path = writeSession(f, "s-young", Date.now() / 1000);

    const { result } = await sweep(f);

    expect(existsSync(path)).toBe(true);
    expect(result?.rebuilds).toMatchObject({ moved: [], kept: [{ sessionId: "s-young", reason: "young" }] });
  });

  it("keeps a rebuild whose thread owner is live or indeterminate, or that is pending acceptance", async () => {
    const f = await fixture("owner");
    recordSessionThread(f.lineageDbPath, "s-candidate", "th_a", {}, { prefix: VERIFIED });
    const path = writeSession(f, "s-candidate");

    writeOwnerLease(f.home, "th_a", LIVE);
    expect((await sweep(f)).result?.rebuilds).toMatchObject({ kept: [{ reason: "thread owner live" }] });
    writeOwnerLease(f.home, "th_a", UNKNOWN);
    expect((await sweep(f)).result?.rebuilds).toMatchObject({ kept: [{ reason: "thread owner indeterminate" }] });
    writeOwnerLease(f.home, "th_a", DEAD);
    recordPendingCurrentSession(f.lineageDbPath, "th_a", "s-candidate", "s-accepted");
    expect((await sweep(f)).result?.rebuilds).toMatchObject({ kept: [{ reason: "pending acceptance" }] });
    expect(existsSync(path)).toBe(true);
  });

  it("does nothing to rebuilds when the registry does not exist", async () => {
    const f = await fixture("noreg");
    recordSessionThread(f.lineageDbPath, "s-abandoned", "th_a", {}, { prefix: VERIFIED });
    const path = writeSession(f, "s-abandoned");
    const { result } = await runLaunchSweep({
      home: f.home,
      cwd: f.cwd,
      registryPath: join(f.home, "missing.sqlite"),
      lineageDbPath: f.lineageDbPath,
      projectsRoot: f.projectsRoot,
      descriptorIo: io(),
      log: logSink(),
    }).then((r) => ({ result: r }));
    expect(existsSync(path)).toBe(true);
    expect(result?.rebuilds).toEqual({ skipped: "no registry" });
  });
});

describe("launch sweep: dead-owner lease reclaim", () => {
  it("reports the reclaimed lease with thread, dead pid, and lease path", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-sweep-reclaim-"));
    const registryPath = join(home, "registry.sqlite");
    const lineageDbPath = join(home, "cc-lhc.sqlite");
    await bindLaunchThread({ sessionId: "s-r", registryPath, lineageDbPath, createThread: async () => "th_r" });
    writeOwnerLease(home, "th_r", DEAD);
    const lines: string[] = [];
    const opened = await openLaunchThread({
      expectedSession: { sessionId: "s-r", source: "explicit_resume" },
      registryPath,
      lineageDbPath,
      home,
      createThread: async () => "th_r",
      log: (m) => lines.push(m),
    });
    opened.lease.release();
    const reclaim = lines.filter((line) => line.includes("reclaimed thread-owner lease"));
    expect(reclaim).toHaveLength(1);
    expect(reclaim[0]).toContain("thread th_r");
    expect(reclaim[0]).toContain(`pid ${DEAD.pid}`);
    expect(reclaim[0]).toContain(threadOwnerPath("th_r", home));
  });
});
