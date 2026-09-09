/**
 * `cc-lhc rollout write`: the fork's native-file entry point. Writes the
 * rebuilt rollout under a fresh session id, records lineage so the first
 * resume skips the replayed prefix, and makes the session current.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type MessageEventInput, threads } from "lhc";
import { beforeEach, describe, expect, it } from "vitest";

import { isRolloutWriteArgv, runRolloutWriteCli } from "../../src/commands/rollout-write.js";
import { lookupSessionLineage } from "../../src/intake/lineage-db.js";
import { rolloutPathForSession } from "../../src/rollout/sessions-index.js";

const SID = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const SID2 = "7a2e3d4c-5b6a-4f7e-9b8c-0d1e2f3a4b5c";

let root: string;
let registryPath: string;
let lineageDbPath: string;
let projectsRoot: string;
let filePath: string;
let threadId: string;
let sdk: Lhc;
let out: string[];
let errs: string[];

async function seedTurn(prompt: string, answer: string, withTool = false): Promise<void> {
  const events: MessageEventInput[] = [
    {
      eventKind: "user_prompt",
      idempotencyKey: `u-${prompt}`,
      actor: "user",
      harness: "cc",
      payload: { text: prompt },
    },
  ];
  if (withTool) {
    events.push(
      {
        eventKind: "tool_call",
        idempotencyKey: `c-${prompt}`,
        actor: "assistant",
        harness: "cc",
        payload: { toolCallId: `call-${prompt}`, toolName: "read_file", arguments: { path: "a" } },
      },
      {
        eventKind: "tool_result",
        idempotencyKey: `r-${prompt}`,
        actor: "tool",
        harness: "cc",
        payload: { toolCallId: `call-${prompt}`, content: "body" },
      },
    );
  }
  events.push(
    {
      eventKind: "assistant_text",
      idempotencyKey: `a-${answer}`,
      actor: "assistant",
      harness: "cc",
      payload: { text: answer },
    },
    { eventKind: "turn_end", idempotencyKey: `e-${prompt}`, actor: "system", harness: "cc", payload: {} },
  );
  const send = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!send.ok) throw new Error(send.error.reason);
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cc-lhc-rollout-write-"));
  registryPath = join(root, "registry.sqlite");
  lineageDbPath = join(root, "cc-lhc.sqlite");
  projectsRoot = join(root, "projects");
  filePath = join(root, "thread.sqlite");
  const created = await threads.newThread({ filePath, registryPath, title: "forked", cwd: join(root, "work") });
  if (!created.ok) throw new Error(created.error.reason);
  threadId = created.value.threadId;
  sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  out = [];
  errs = [];
});

function deps() {
  return {
    registryPath,
    lineageDbPath,
    projectsRoot,
    initSdk: () => sdk,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => errs.push(line),
  };
}

function run(...rest: string[]): Promise<number> {
  return runRolloutWriteCli(["rollout", "write", ...rest], deps());
}

describe("rollout write CLI", () => {
  it("claims only its own argv head", () => {
    expect(isRolloutWriteArgv(["rollout", "write", "--thread-id", "x"])).toBe(true);
    expect(isRolloutWriteArgv(["rollout"])).toBe(false);
    expect(isRolloutWriteArgv(["backfill-labels"])).toBe(false);
  });

  it("refuses bad arguments with usage and writes nothing", async () => {
    expect(await run()).toBe(2);
    expect(errs.at(-1)).toMatch(/^usage:/);
    errs = [];
    expect(await run("--thread-id", threadId, "--session-id", SID, "--force")).toBe(2);
    expect(errs[0]).toContain("unknown flag");
    errs = [];
    expect(await run("--thread-id", threadId, "--session-id", "not-a-uuid")).toBe(2);
    expect(errs[0]).toMatch(/^usage: --session-id must be a fresh uuid/);
    errs = [];
    expect(await run("--thread-id", "th_missing", "--session-id", SID)).toBe(2);
    expect(errs[0]).toMatch(/^thread_not_found: /);
    expect(existsSync(projectsRoot)).toBe(false);
  });

  it("writes the rollout, records the replayed prefix, and makes the session current", async () => {
    await seedTurn("first", "one", true);
    await seedTurn("second", "two");
    const cwd = join(root, "work");
    expect(await run("--thread-id", threadId, "--session-id", SID)).toBe(0);
    expect(errs).toEqual([]);
    const rolloutPath = rolloutPathForSession(projectsRoot, cwd, SID);
    const lines = readFileSync(rolloutPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(out).toEqual([`${SID} ${rolloutPath} lines=${lines.length}`]);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line).sessionId).toBe(SID);
    expect(readFileSync(rolloutPath, "utf8")).toContain("second");

    const lineage = lookupSessionLineage(lineageDbPath, SID);
    expect(lineage?.threadId).toBe(threadId);
    expect(lineage?.prefix.kind).toBe("verified");
    expect(lineage?.replayedPrefixLines).toBe(lines.length);

    const current = await threads.currentAlias({ threadId, registryPath });
    expect(current.ok && current.value.currentAlias).toBe(`claude-code:${SID}`);
    const resolved = await threads.resolveAlias({ alias: `claude-code:${SID}`, registryPath });
    expect(resolved.ok && resolved.value.threadId).toBe(threadId);

    // The same session id again: the rollout exists, refuse before touching anything.
    out = [];
    expect(await run("--thread-id", threadId, "--session-id", SID)).toBe(2);
    expect(errs[0]).toMatch(/^path_exists: /);
    expect(out).toEqual([]);

    // Registry cwd is the default; an explicit --cwd writes under another project dir.
    errs = [];
    expect(await run("--thread-id", threadId, "--session-id", SID2, "--cwd", join(root, "elsewhere"))).toBe(0);
    expect(existsSync(rolloutPathForSession(projectsRoot, join(root, "elsewhere"), SID2))).toBe(true);
    const advanced = await threads.currentAlias({ threadId, registryPath });
    expect(advanced.ok && advanced.value.currentAlias).toBe(`claude-code:${SID2}`);
  });

  it("refuses an empty view and a session id bound to another thread", async () => {
    expect(await run("--thread-id", threadId, "--session-id", SID)).toBe(2);
    expect(errs[0]).toMatch(/^empty_view: /);
    expect(existsSync(projectsRoot)).toBe(false);

    await seedTurn("first", "one");
    const otherPath = join(root, "other.sqlite");
    const other = await threads.newThread({ filePath: otherPath, registryPath, cwd: "/o" });
    if (!other.ok) throw new Error(other.error.reason);
    const bound = await threads.registerCurrentAlias({
      alias: `claude-code:${SID}`,
      threadId: other.value.threadId,
      registryPath,
    });
    expect(bound.ok).toBe(true);
    errs = [];
    expect(await run("--thread-id", threadId, "--session-id", SID)).toBe(2);
    expect(errs[0]).toMatch(/^alias_bound_to_other_thread: /);
    expect(existsSync(projectsRoot)).toBe(false);
  });

  it("refuses a thread with no cwd anywhere", async () => {
    const bare = await threads.newThread({ filePath: join(root, "bare.sqlite"), registryPath });
    if (!bare.ok) throw new Error(bare.error.reason);
    expect(await run("--thread-id", bare.value.threadId, "--session-id", SID)).toBe(2);
    expect(errs[0]).toMatch(/has no registry cwd; pass --cwd/);
  });
});
