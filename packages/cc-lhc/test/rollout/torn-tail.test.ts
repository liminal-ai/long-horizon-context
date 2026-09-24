import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessControl } from "cc-lhc-native";
import { afterEach, describe, expect, it } from "vitest";
import { observeWatcherEmission } from "../../src/observation/observe.js";
import { encodeProjectPath } from "../../src/rollout/discover.js";
import { repairTornTranscriptTail } from "../../src/rollout/torn-tail.js";
import type { WatcherEmission } from "../../src/rollout/types.js";
import { type RolloutWatcher, watchRolloutFile } from "../../src/rollout/watcher.js";
import { findFileHolders } from "../../src/runtime/file-holders.js";
import { repairResumedTranscript } from "../../src/wrapper/resume-repair.js";

const line = (uuid: string): string =>
  `${JSON.stringify({ type: "user", uuid, message: { role: "user", content: uuid } })}\n`;

const noHolders = () => ({ ok: true as const, holders: [] });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Fixture {
  home: string;
  projectsRoot: string;
  cwd: string;
  path: string;
}

function fixture(label: string, content: string): Fixture {
  const home = mkdtempSync(join(tmpdir(), `cc-lhc-torn-${label}-`));
  const projectsRoot = join(home, "projects");
  const cwd = "/work/torn";
  const dir = join(projectsRoot, encodeProjectPath(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "s-torn.jsonl");
  writeFileSync(path, content);
  return { home, projectsRoot, cwd, path };
}

function sink() {
  const log: string[] = [];
  const err: string[] = [];
  return {
    log,
    err,
    logger: { info: (m: string) => log.push(m), warn: (m: string) => log.push(`warn ${m}`) },
    stderr: { write: (chunk: string) => err.push(chunk) },
  };
}

// The real holder check. The suite-wide CC_LHC_IDENTITY_ADDON stub answers
// `listFileHolders` as unsupported, so on Windows the check must load the
// compiled addon with the override removed (`env: {}`), as the other
// real-addon suites do; Linux and macOS never reach the addon.
const realControl = createProcessControl({ env: {} });
const realFindHolders = (path: string) =>
  findFileHolders(path, { nativeHolders: (target) => realControl.listFileHolders(target) });

describe("pre-launch torn-tail repair", () => {
  let watcher: RolloutWatcher | undefined;
  let holder: ChildProcess | undefined;
  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    holder?.kill("SIGKILL");
    holder = undefined;
  });

  it("torn non-JSON tail: fragment saved, transcript trimmed, capture reaches ready", async () => {
    const good = line("a") + line("b");
    const fragment = '{"type":"assistant","uuid":"c","mess';
    const f = fixture("trim", good + fragment);
    const out = sink();

    const repair = repairResumedTranscript({
      sessionId: "s-torn",
      cwd: f.cwd,
      home: f.home,
      projectsRoot: f.projectsRoot,
      log: out.logger,
      stderr: out.stderr,
      findHolders: noHolders,
    });

    expect(repair.kind).toBe("fragment_trimmed");
    if (repair.kind !== "fragment_trimmed") return;
    expect(readFileSync(f.path, "utf8")).toBe(good);
    expect(readFileSync(repair.sideFile, "utf8")).toBe(fragment);
    expect(repair.sideFile.startsWith(join(f.home, "torn-lines", "s-torn-"))).toBe(true);
    expect(out.log.join("\n")).toContain(`saved ${Buffer.byteLength(fragment)} bytes to ${repair.sideFile}`);
    expect(out.err).toHaveLength(1);

    const emissions: WatcherEmission[] = [];
    watcher = watchRolloutFile({ filePath: f.path, pollMs: 40, onBatch: (em) => void emissions.push(...em) });
    await watcher.initialCatchUp;
    expect(emissions.map((e) => e.kind)).toEqual(["line", "line"]);
  });

  it("complete record missing its newline: newline appended, record kept", () => {
    const content = line("a") + line("b").trimEnd();
    const f = fixture("newline", content);
    const repair = repairTornTranscriptTail({
      path: f.path,
      sessionId: "s-torn",
      home: f.home,
      findHolders: noHolders,
    });
    expect(repair).toEqual({ kind: "newline_appended", recordBytes: Buffer.byteLength(line("b")) - 1 });
    expect(readFileSync(f.path, "utf8")).toBe(`${content}\n`);
  });

  it("clean transcript is untouched byte-for-byte", () => {
    const content = line("a") + line("b");
    const f = fixture("clean", content);
    const before = statSync(f.path);
    let holderChecks = 0;
    const repair = repairTornTranscriptTail({
      path: f.path,
      sessionId: "s-torn",
      home: f.home,
      findHolders: () => {
        holderChecks += 1;
        return noHolders();
      },
    });
    expect(repair).toEqual({ kind: "clean" });
    expect(readFileSync(f.path)).toEqual(Buffer.from(content));
    expect(statSync(f.path).mtimeMs).toBe(before.mtimeMs);
    expect(holderChecks).toBe(0);
  });

  it("missing transcript (fresh launch) is a no-op", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-torn-missing-"));
    expect(repairTornTranscriptTail({ path: join(home, "nope.jsonl"), sessionId: "x", home })).toEqual({
      kind: "missing",
    });
  });

  it("an unheld torn transcript is repaired through the real holder check (our own read handle never counts)", () => {
    const content = `${line("a")}{"torn`;
    const f = fixture("unheld", content);
    const repair = repairTornTranscriptTail({
      path: f.path,
      sessionId: "s-torn",
      home: f.home,
      findHolders: realFindHolders,
    });
    // The whole result, so a refusal prints its reason.
    expect(repair).toMatchObject({ kind: "fragment_trimmed" });
    expect(readFileSync(f.path, "utf8")).toBe(line("a"));
  });

  it("a transcript that changes during the holder check is left untouched", () => {
    const content = `${line("a")}{"torn`;
    const f = fixture("changed", content);
    const repair = repairTornTranscriptTail({
      path: f.path,
      sessionId: "s-torn",
      home: f.home,
      findHolders: (path) => {
        appendFileSync(path, 'more"}');
        return { ok: true, holders: [] };
      },
    });
    expect(repair).toMatchObject({
      kind: "holder_check_unavailable",
      reason: "transcript changed during the holder check",
    });
    expect(readFileSync(f.path, "utf8")).toBe(`${content}more"}`);
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32")(
    "transcript held open by another process: untouched and the holder named",
    async () => {
      const content = `${line("a")}{"torn`;
      const f = fixture("held", content);
      holder = spawn(
        process.execPath,
        [
          "-e",
          `require("fs").openSync(${JSON.stringify(f.path)}, "a"); console.log("open"); setInterval(() => {}, 1000);`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      await new Promise<void>((resolve) => holder!.stdout!.once("data", () => resolve()));
      const out = sink();

      const repair = repairResumedTranscript({
        sessionId: "s-torn",
        cwd: f.cwd,
        home: f.home,
        projectsRoot: f.projectsRoot,
        log: out.logger,
        stderr: out.stderr,
        findHolders: realFindHolders,
      });

      expect(repair).toMatchObject({ kind: "held_open" });
      if (repair.kind !== "held_open") return;
      expect(repair.holders.map((h) => h.pid)).toContain(holder.pid);
      expect(readFileSync(f.path, "utf8")).toBe(content);
      expect(out.err.join("")).toContain(`pid ${String(holder.pid)} (`);
      expect(out.err.join("")).toContain("left untouched");
    },
  );

  it("no holder check available: file untouched", () => {
    const content = `${line("a")}{"torn`;
    const f = fixture("unavail", content);
    const repair = repairTornTranscriptTail({
      path: f.path,
      sessionId: "s-torn",
      home: f.home,
      findHolders: () => ({ ok: false, reason: "unsupported" }),
    });
    expect(repair.kind).toBe("holder_check_unavailable");
    expect(readFileSync(f.path, "utf8")).toBe(content);
  });
});

describe("watcher on an unterminated tail", () => {
  let watcher: RolloutWatcher | undefined;
  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
  });

  it("initial partial tail: ready with complete lines, then ingests the tail once its newline arrives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-torn-watch-"));
    const path = join(dir, "s.jsonl");
    const tail = line("tail");
    writeFileSync(path, line("a") + tail.slice(0, 20));
    const uuids: string[] = [];
    const errors: WatcherEmission[] = [];
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      onBatch: (em) => {
        for (const e of em) {
          if (e.kind === "line") uuids.push(String(e.item.uuid));
          else errors.push(e);
        }
      },
    });
    await watcher.initialCatchUp;
    expect(uuids).toEqual(["a"]);
    await sleep(120);
    expect(uuids).toEqual(["a"]);
    appendFileSync(path, tail.slice(20));
    await sleep(200);
    expect(uuids).toEqual(["a", "tail"]);
    expect(errors).toHaveLength(0);
    expect(watcher.isTerminal?.()).toBe(false);
  });

  it("live partial tail: waits, then ingests on completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-torn-live-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, line("a"));
    const uuids: string[] = [];
    watcher = watchRolloutFile({
      filePath: path,
      pollMs: 40,
      onBatch: (em) => {
        for (const e of em) if (e.kind === "line") uuids.push(String(e.item.uuid));
      },
    });
    await watcher.initialCatchUp;
    const next = line("b");
    appendFileSync(path, next.slice(0, 15));
    await sleep(150);
    expect(uuids).toEqual(["a"]);
    appendFileSync(path, next.slice(15));
    await sleep(200);
    expect(uuids).toEqual(["a", "b"]);
  });

  it("a complete corrupt line mid-file still degrades capture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-lhc-torn-corrupt-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, `${line("a")}{"not json\n${line("c")}{"partial`);
    const emissions: WatcherEmission[] = [];
    watcher = watchRolloutFile({ filePath: path, pollMs: 40, onBatch: (em) => void emissions.push(...em) });
    await watcher.initialCatchUp;
    expect(emissions.map((e) => e.kind)).toEqual(["line", "parse_error", "line"]);
    const observed = observeWatcherEmission(emissions[1]!, 1);
    expect(observed.lifecycle).toEqual([
      expect.objectContaining({ kind: "capture_degraded", reason: expect.stringMatching(/^parse_error:/) }),
    ]);
  });
});
