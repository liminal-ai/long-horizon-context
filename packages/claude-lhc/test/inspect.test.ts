import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { inspectSessions, type SidecarCommand } from "../src/client/index.ts";
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

const { ClaudeLhcSession } = await import("../src/session.ts");
const { threadRef } = await import("../src/lhcHome.ts");

const SIDECAR = fileURLToPath(new URL("../src/sidecar.ts", import.meta.url));

let dir = "";
let home = "";
let cwd = "";
let starts = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, noInference: process.env.CLAUDE_LHC_NO_INFERENCE };

beforeEach(() => {
  opened.length = 0;
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-inspect-"));
  home = join(dir, "lhc");
  cwd = mkdtempSync(join(dir, "cwd-"));
  starts = join(dir, "sidecar-starts.log");
  writeFileSync(
    join(dir, "count-start.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(starts)}, process.pid + "\\n");\n`,
  );
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

const sidecar = (): SidecarCommand => ({
  command: process.execPath,
  args: ["--import", "tsx", "--import", join(dir, "count-start.mjs"), SIDECAR],
});
const inspect = (ids: string[], lhcHome = home) => inspectSessions(ids, { lhc: { home: lhcHome, spawn: sidecar() } });
const sidecarStarts = () => (existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").length : 0);

function session() {
  return new ClaudeLhcSession({
    emit(): void {},
    request: async () => ({}),
    end(): void {},
    fail(): void {},
    log(): void {},
  });
}

async function resumedThread(): Promise<{ gen1: string; threadId: string; resumed: string }> {
  const { gen1, threadId } = await seedThread(home, cwd);
  await captureTurn(home, threadId, "FIRST-PROMPT", "FIRST-ANSWER");
  const s = session();
  await s.start({ resume: gen1, cwd, model: "claude-sonnet-5", env: { ...process.env }, lhc: { home } });
  await s.close();
  return { gen1, threadId, resumed: opened.at(-1)!.resume! };
}

async function compactedThread(): Promise<{ gen1: string; threadId: string; compacted: string }> {
  const { gen1, threadId } = await seedThread(home, cwd);
  await captureTurn(home, threadId, "FIRST-PROMPT", "FIRST-ANSWER");
  await seedLhc().work.drain(threadRef(threadId, home));
  const s = session();
  await s.start({ resume: gen1, cwd, model: "claude-sonnet-5", env: { ...process.env }, lhc: { home } });
  await s.pushUser({
    type: "user",
    message: { role: "user", content: "/compact" },
    parent_tool_use_id: null,
    session_id: "",
  });
  await s.close();
  expect(opened).toHaveLength(2);
  return { gen1, threadId, compacted: opened.at(-1)!.resume! };
}

describe("inspectSessions", () => {
  test("a fresh alias is managed and is its thread's current session", async () => {
    const { gen1, threadId } = await seedThread(home, cwd);

    expect(await inspect([gen1])).toEqual([{ kind: "managed", threadId, currentSessionId: gen1 }]);
  });

  test("an alias a resume superseded names the resumed generation", async () => {
    const { gen1, threadId, resumed } = await resumedThread();
    expect(resumed).not.toBe(gen1);

    const current = { kind: "managed", threadId, currentSessionId: resumed };
    expect(await inspect([gen1, resumed])).toEqual([current, current]);
  });

  test("an alias a compact superseded names the compacted generation", async () => {
    const { gen1, threadId, compacted } = await compactedThread();
    expect(compacted).not.toBe(gen1);

    const current = { kind: "managed", threadId, currentSessionId: compacted };
    expect(await inspect([gen1, compacted])).toEqual([current, current]);
  });

  test("a random id is unknown", async () => {
    await seedThread(home, cwd);

    expect(await inspect([randomUUID()])).toEqual([{ kind: "unknown" }]);
  });

  test("a mixed batch of 500 ids answers in order from one sidecar start", async () => {
    const seeded = await Promise.all([1, 2, 3].map(() => seedThread(home, cwd)));
    const ids = Array.from({ length: 500 }, () => randomUUID());
    const managed = new Map(seeded.map((thread, i) => [i * 200, thread] as const));
    for (const [at, thread] of managed) ids[at] = thread.gen1;

    const answers = await inspect(ids);

    expect(sidecarStarts()).toBe(1);
    expect(answers).toHaveLength(500);
    expect(answers).toEqual(
      ids.map((id, at) => {
        const thread = managed.get(at);
        return thread === undefined
          ? { kind: "unknown" }
          : { kind: "managed", threadId: thread.threadId, currentSessionId: id };
      }),
    );
  });

  test("a corrupted registry fails the whole call with a store error", async () => {
    const { gen1 } = await seedThread(home, cwd);
    writeFileSync(join(home, "registry.sqlite"), "not a sqlite database\n".repeat(64));

    await expect(inspect([gen1, randomUUID()])).rejects.toThrow(/^LHC registry read failed: /);
  });

  test("an absent store answers unknown and creates no file", async () => {
    const absent = join(dir, "no-store-here");

    expect(await inspect([randomUUID(), randomUUID()], absent)).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
    expect(existsSync(absent)).toBe(false);
  });
});
