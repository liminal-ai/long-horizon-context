import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { captureTurn, seedLhc, seedThread } from "./support/seedThread.ts";

const opened: Options[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...real,
    query: ({ options }: { options: Options }) => {
      opened.push(options);
      const never = new Promise<IteratorResult<never>>(() => {});
      return {
        [Symbol.asyncIterator]() {
          return { next: () => never };
        },
        getContextUsage: async () => ({ rawMaxTokens: 1_000_000, totalTokens: 0 }),
        interrupt: async () => {},
        close: () => {},
      };
    },
  };
});

const { forkSession } = await import("../src/index.ts");
const { ClaudeLhcSession } = await import("../src/session.ts");
const { resolveSession, threadRef } = await import("../src/lhcHome.ts");
const { nativeProjectDir, nativeSessionPath } = await import("../src/nativeSessionFile.ts");
const { eventCursor } = await import("../src/rollbackAnchor.ts");

let dir = "";
let home = "";
let cwd = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, noInference: process.env.CLAUDE_LHC_NO_INFERENCE };

beforeEach(() => {
  opened.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-fork-cursor-"));
  home = join(dir, "lhc");
  cwd = mkdtempSync(join(dir, "cwd-"));
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-home");
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
});
afterEach(() => {
  for (const [key, value] of [
    ["CLAUDE_CONFIG_DIR", saved.config],
    ["CLAUDE_LHC_NO_INFERENCE", saved.noInference],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const store = () => ({ lhc: { home } });
const projectDir = () => nativeProjectDir({ cwd, env: process.env });
const nativeFiles = () => readdirSync(projectDir()).filter((name) => name.endsWith(".jsonl"));
const threadFiles = () => readdirSync(join(home, "threads")).filter((name) => name.endsWith(".sqlite"));

function dropProjections(): void {
  const files = nativeFiles();
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) rmSync(join(projectDir(), name));
}

function snapshot(): string {
  const hash = createHash("sha256");
  for (const root of [projectDir(), join(home, "threads")])
    for (const name of readdirSync(root).sort()) hash.update(name).update(readFileSync(join(root, name)));
  return hash.digest("hex");
}

async function eventKeys(threadId: string): Promise<string[]> {
  const page = await seedLhc().intakeStream.listEventKeysByPrefix(threadRef(threadId, home), { prefix: "claude-lhc:" });
  if (!page.ok) throw new Error(page.error.reason);
  return page.value.keys.map((key) => key.idempotencyKey);
}

async function threadOf(sessionId: string): Promise<string> {
  const threadId = await resolveSession(sessionId, home);
  if (threadId === null) throw new Error(`no thread for ${sessionId}`);
  return threadId;
}

async function run(sessionId: string, extra: Record<string, unknown> = {}, prompt?: string) {
  const logs: string[] = [];
  const session = new ClaudeLhcSession({
    emit(): void {},
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log: (line: string) => logs.push(line),
  });
  await session.start({
    resume: sessionId,
    cwd,
    model: "claude-sonnet-5",
    env: { ...process.env },
    lhc: { home },
    ...extra,
  });
  if (prompt !== undefined)
    await session.pushUser({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      session_id: "",
    });
  await session.close();
  const generation = opened.at(-1)!.resume!;
  return { logs, projected: readFileSync(nativeSessionPath({ sessionId: generation, cwd, env: process.env }), "utf8") };
}

async function compact(sessionId: string): Promise<void> {
  await seedLhc().work.drain(threadRef(await threadOf(sessionId), home));
  await run(sessionId, {}, "/compact");
}

async function twoTurns() {
  const { gen1, threadId } = await seedThread(home, cwd);
  const kept = await captureTurn(home, threadId, "KEEP-PROMPT", "KEEP-ANSWER");
  await captureTurn(home, threadId, "LATER-PROMPT", "LATER-ANSWER");
  return { gen1, threadId, kept };
}

async function forkAtKeep() {
  const { gen1, threadId, kept } = await twoTurns();
  const forked = await forkSession(gen1, { ...store(), upToMessageId: kept });
  expect(forked.headMessageId).toBeDefined();
  return { gen1, threadId, kept, forked, forkThread: await threadOf(forked.sessionId), head: forked.headMessageId! };
}

describe("a fork's headMessageId", () => {
  test("names the fork's thread, not a line of its projection", async () => {
    const { forked, forkThread, head } = await forkAtKeep();

    expect(head.startsWith(`claude-lhc-cursor:${forkThread}:claude-lhc:`)).toBe(true);
    const file = readFileSync(nativeSessionPath({ sessionId: forked.sessionId, cwd, env: process.env }), "utf8");
    expect(file).not.toContain(head);
  });

  test("rolls the fork back to its fork point after its projection is gone, a restart and a compact", async () => {
    const { forked, forkThread, head } = await forkAtKeep();
    await captureTurn(home, forkThread, "FORK-PROMPT", "FORK-ANSWER");

    dropProjections();
    const restarted = await run(forked.sessionId);
    expect(restarted.projected).toContain("FORK-ANSWER");
    await compact(forked.sessionId);
    dropProjections();
    const rolled = await run(forked.sessionId, { resumeSessionAt: head });

    expect(rolled.logs).toContainEqual(expect.stringMatching(`^rollback to event \\d+ via ${head}$`));
    expect(rolled.projected).toContain("KEEP-ANSWER");
    expect(rolled.projected).not.toContain("FORK-ANSWER");
    expect(rolled.projected).not.toContain("LATER-ANSWER");
  });

  test("of a fork cut at the first fork's head names the second fork and rolls it back there", async () => {
    const first = await forkAtKeep();
    await captureTurn(home, first.forkThread, "FIRST-FORK-PROMPT", "FIRST-FORK-ANSWER");

    const second = await forkSession(first.forked.sessionId, { ...store(), upToMessageId: first.head });
    const secondThread = await threadOf(second.sessionId);
    expect(second.headMessageId?.startsWith(`claude-lhc-cursor:${secondThread}:`)).toBe(true);
    await captureTurn(home, secondThread, "SECOND-FORK-PROMPT", "SECOND-FORK-ANSWER");
    dropProjections();
    const rolled = await run(second.sessionId, { resumeSessionAt: second.headMessageId });

    expect(rolled.projected).toContain("KEEP-ANSWER");
    expect(rolled.projected).not.toContain("FIRST-FORK-ANSWER");
    expect(rolled.projected).not.toContain("SECOND-FORK-ANSWER");
  });

  test("from before the cursor, the fork file's last line uuid, still works as resumeSessionAt and upToMessageId", async () => {
    const { forked, forkThread } = await forkAtKeep();
    const file = readFileSync(nativeSessionPath({ sessionId: forked.sessionId, cwd, env: process.env }), "utf8");
    const legacyHead = JSON.parse(file.trim().split("\n").at(-1)!).uuid as string;
    await captureTurn(home, forkThread, "FORK-PROMPT", "FORK-ANSWER");

    const again = await forkSession(forked.sessionId, { ...store(), upToMessageId: legacyHead });
    const rolled = await run(forked.sessionId, { resumeSessionAt: legacyHead });

    const forkOfFork = readFileSync(nativeSessionPath({ sessionId: again.sessionId, cwd, env: process.env }), "utf8");
    expect(forkOfFork).toContain("KEEP-ANSWER");
    expect(forkOfFork).not.toContain("FORK-ANSWER");
    expect(rolled.logs).toContainEqual(expect.stringMatching(`^rollback to event \\d+ via `));
    expect(rolled.projected).toContain("KEEP-ANSWER");
    expect(rolled.projected).not.toContain("FORK-ANSWER");
  });

  test("an empty fork has none", async () => {
    const { gen1 } = await seedThread(home, cwd);

    const forked = await forkSession(gen1, store());

    expect(forked.headMessageId).toBeUndefined();
  });
});

test("a wire uuid captured before a compact still anchors a rollback on a fork with no projection", async () => {
  const { gen1, kept } = await twoTurns();
  const forked = await forkSession(gen1, store());
  await compact(forked.sessionId);

  dropProjections();
  const rolled = await run(forked.sessionId, { resumeSessionAt: kept });

  expect(rolled.logs).toContainEqual(expect.stringMatching(`^rollback to event \\d+ via ${kept}$`));
  expect(rolled.projected).toContain("KEEP-ANSWER");
  expect(rolled.projected).not.toContain("LATER-ANSWER");
});

describe("a cursor the thread does not hold is refused with no append and no file change", () => {
  test("another fork's cursor", async () => {
    const { gen1, kept } = await twoTurns();
    const target = await forkSession(gen1, { ...store(), upToMessageId: kept });
    const other = await forkSession(gen1, { ...store(), upToMessageId: kept });
    const foreign = other.headMessageId!;
    const otherThread = await threadOf(other.sessionId);
    const targetThread = await threadOf(target.sessionId);
    const keys = await eventKeys(targetThread);
    const before = snapshot();

    await expect(run(target.sessionId, { resumeSessionAt: foreign })).rejects.toThrow(
      `rollback cursor ${foreign} names LHC thread ${otherThread}, not ${targetThread}`,
    );
    await expect(forkSession(target.sessionId, { ...store(), upToMessageId: foreign })).rejects.toThrow(
      `names LHC thread ${otherThread}`,
    );

    expect(await eventKeys(targetThread)).toEqual(keys);
    expect(snapshot()).toBe(before);
  });

  test("a cursor naming no event of the thread", async () => {
    const { forked, forkThread } = await forkAtKeep();
    const unknown = eventCursor(forkThread, `claude-lhc:${randomUUID()}:0:assistant_text`);
    const keys = await eventKeys(forkThread);
    const copies = threadFiles().length;
    const before = snapshot();

    await expect(run(forked.sessionId, { resumeSessionAt: unknown })).rejects.toThrow(
      `rollback anchor ${unknown} not found`,
    );
    await expect(forkSession(forked.sessionId, { ...store(), upToMessageId: unknown })).rejects.toThrow(
      `rollback anchor ${unknown} not found`,
    );

    expect(await eventKeys(forkThread)).toEqual(keys);
    expect(threadFiles()).toHaveLength(copies);
    expect(snapshot()).toBe(before);
  });
});
