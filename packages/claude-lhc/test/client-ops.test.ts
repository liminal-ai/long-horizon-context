import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { forkSession, getSessionMessages, getSubagentMessages, type SidecarCommand } from "../src/client/index.ts";
import { bindSession } from "../src/lhcHome.ts";
import { nativeProjectDir, nativeSessionPath } from "../src/nativeSessionFile.ts";
import { captureTurn, seedThread } from "./support/seedThread.ts";

const SIDECAR = fileURLToPath(new URL("../src/sidecar.ts", import.meta.url));

let dir = "";
let home = "";
let cwd = "";
let hostHome = "";
let opHome = "";
const saved = { config: process.env.CLAUDE_CONFIG_DIR, noInference: process.env.CLAUDE_LHC_NO_INFERENCE };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-lhc-client-ops-"));
  home = join(dir, "lhc");
  cwd = mkdtempSync(join(dir, "cwd-"));
  hostHome = join(dir, "host-claude");
  opHome = join(dir, "operation claude");
  process.env.CLAUDE_CONFIG_DIR = hostHome;
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

const sidecar = (env: NodeJS.ProcessEnv = process.env): SidecarCommand => ({
  command: process.execPath,
  args: ["--import", "tsx", SIDECAR],
  env,
});
const store = (env?: NodeJS.ProcessEnv) => ({ lhc: { home, spawn: sidecar(env) } });
const opEnv = () => ({ ...process.env, CLAUDE_CONFIG_DIR: opHome });
const linesOf = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function capturedThread(): Promise<{ gen1: string; threadId: string }> {
  const seeded = await seedThread(home, cwd);
  await captureTurn(home, seeded.threadId, "FIRST-PROMPT", "FIRST-ANSWER");
  return seeded;
}

function writeSubagent(claudeHome: string, sessionId: string, agentId: string, toolUseId: string): void {
  const session = nativeSessionPath({ sessionId, cwd, env: { CLAUDE_CONFIG_DIR: claudeHome } });
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(
    session,
    `${JSON.stringify({ parentUuid: null, type: "user", uuid: randomUUID(), sessionId, cwd, message: { role: "user", content: "PARENT" } })}\n`,
  );
  const subagents = join(nativeProjectDir({ cwd, env: { CLAUDE_CONFIG_DIR: claudeHome } }), sessionId, "subagents");
  mkdirSync(subagents, { recursive: true });
  const first = randomUUID();
  const line = (uuid: string, parentUuid: string | null, role: "user" | "assistant", text: string) =>
    JSON.stringify({
      parentUuid,
      isSidechain: true,
      agentId,
      type: role,
      uuid,
      sessionId,
      cwd,
      message: { role, content: [{ type: "text", text }] },
    });
  writeFileSync(
    join(subagents, `agent-${agentId}.jsonl`),
    `${line(first, null, "user", "AGENT-TASK")}\n${line(randomUUID(), first, "assistant", "AGENT-REPLY")}\n`,
  );
  writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general", toolUseId }));
}

describe("forkSession from the client entry", () => {
  test("writes the fork's projection into the Claude home named only in the operation's env", async () => {
    const { gen1 } = await capturedThread();

    const fork = await forkSession(gen1, { env: opEnv(), lhc: { home, spawn: sidecar() } });

    const path = nativeSessionPath({ sessionId: fork.sessionId, cwd, env: { CLAUDE_CONFIG_DIR: opHome } });
    const lines = linesOf(path);
    expect(JSON.stringify(lines)).toContain("FIRST-ANSWER");
    expect(fork.headMessageId).toBe(lines.filter((line) => typeof line["uuid"] === "string").at(-1)?.["uuid"]);
    expect(existsSync(join(hostHome, "projects"))).toBe(false);
    expect((await getSessionMessages(fork.sessionId, { env: opEnv(), ...store() })).length).toBeGreaterThan(0);
  });

  test("runs summaries with the operation's Claude binary and env, from a path with spaces", async () => {
    const { gen1 } = await capturedThread();
    const marker = join(dir, "invoked.txt");
    const bin = join(dir, "bin with spaces", "fake claude");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\necho "$0 $LHC_OPERATION_MARK" >> "${marker}"\nexit 1\n`);
    chmodSync(bin, 0o755);
    const { CLAUDE_LHC_NO_INFERENCE: _off, ...inference } = process.env;

    const env = { ...opEnv(), LHC_OPERATION_MARK: "from-operation-env" };

    await forkSession(gen1, { env, pathToClaudeCodeExecutable: bin, ...store(inference) }).catch(() => undefined);

    expect(readFileSync(marker, "utf8").trim().split("\n")).toContain(`${bin} from-operation-env`);
  });

  test("an operation env with HOME and no CLAUDE_CONFIG_DIR writes under that HOME's .claude", async () => {
    const { gen1 } = await capturedThread();
    const userHome = join(dir, "operation user");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, USERPROFILE: userHome };
    delete env.CLAUDE_CONFIG_DIR;

    const fork = await forkSession(gen1, { env, ...store() });

    const claudeHome = join(userHome, ".claude");
    expect(
      existsSync(nativeSessionPath({ sessionId: fork.sessionId, cwd, env: { CLAUDE_CONFIG_DIR: claudeHome } })),
    ).toBe(true);
    expect(existsSync(join(hostHome, "projects"))).toBe(false);
  });

  test("with no env or binary, runs against the sidecar's own Claude home", async () => {
    const { gen1 } = await capturedThread();

    const fork = await forkSession(gen1, store());

    expect(
      existsSync(nativeSessionPath({ sessionId: fork.sessionId, cwd, env: { CLAUDE_CONFIG_DIR: hostHome } })),
    ).toBe(true);
    expect(existsSync(join(opHome, "projects"))).toBe(false);
  });
});

describe("history from the client entry", () => {
  test("getSubagentMessages finds a sidechain written under a later generation", async () => {
    const { gen1, threadId } = await capturedThread();
    const later = randomUUID();
    await bindSession(threadId, later, home);
    const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    writeSubagent(opHome, later, agentId, "toolu_later");

    const messages = await getSubagentMessages(gen1, agentId, { env: opEnv(), dir: cwd, ...store() });

    expect(messages.map((message) => message.type)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(messages)).toContain("AGENT-REPLY");
    expect(messages[0]?.parent_tool_use_id).toBe("toolu_later");
  });
});

describe("a failed operation", () => {
  test("rejects with the sidecar's error and leaves no fork behind", async () => {
    await capturedThread();
    const unknown = randomUUID();

    await expect(forkSession(unknown, { env: opEnv(), ...store() })).rejects.toThrow(
      `no LHC thread holds the Claude session ${unknown}`,
    );
    expect(existsSync(join(opHome, "projects"))).toBe(false);
  });

  test("a sidecar that exits with no result rejects with its exit and stderr", async () => {
    const crash: SidecarCommand = {
      command: process.execPath,
      args: ["-e", "process.stderr.write('boom\\n'); process.exit(3)"],
    };

    await expect(getSessionMessages(randomUUID(), { lhc: { home, spawn: crash } })).rejects.toThrow(
      /getSessionMessages sidecar exited \(code 3, signal none\) with no result\nboom/,
    );
  });
});
