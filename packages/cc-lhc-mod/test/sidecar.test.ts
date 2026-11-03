import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { acquireLease } from "../sidecar/src/lease.ts";

const main = join(import.meta.dirname, "..", "sidecar", "src", "main.ts");
let home: string;
let child: ChildProcess | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lhc-sidecar-"));
  return () => rmSync(home, { recursive: true, force: true });
});

afterEach(async () => {
  const running = child;
  child = undefined;
  if (running === undefined || running.exitCode !== null) return;
  const exited = new Promise((resolve) => running.once("exit", resolve));
  running.kill();
  await exited;
});

function start(id: string): Promise<string> {
  child = spawn(process.execPath, [main, "--home", home, "--id", id], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child?.stdout?.on("data", (chunk: Buffer) => {
      out += chunk;
      const match = /listening (\S+)/.exec(out);
      if (match?.[1] !== undefined) resolve(match[1]);
    });
    child?.on("exit", (code) => reject(new Error(`sidecar exited ${code}`)));
  });
}

function call(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("sidecar", () => {
  it("answers health with the session it is bound to", async () => {
    const socket = await start("bind1");
    const binding = { sessionId: "s-1", transcriptPath: "/t/s-1.jsonl", source: "startup" };

    expect((await call(socket, "POST", "/bind", binding)).status).toBe(200);
    expect(
      (await call(socket, "POST", "/policy", { window: 1_000_000, trigger: 800_000, target: 140_000 })).status,
    ).toBe(200);
    const health = await call(socket, "GET", "/health");

    expect(health.json).toMatchObject({ binding, policy: { window: 1_000_000, trigger: 800_000, target: 140_000 } });
    const log = readFileSync(join(home, "logs", "sidecar-bind1.log"), "utf8");
    expect(log).toContain("bound session s-1 transcript /t/s-1.jsonl source startup");
  });

  it("keeps its socket in a private directory and replaces a stale socket file", async () => {
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o755 });
    writeFileSync(join(home, "run", "stale1.sock"), "left by a killed sidecar");

    const socket = await start("stale1");

    expect(statSync(join(home, "run")).mode & 0o777).toBe(0o700);
    expect((await call(socket, "GET", "/health")).status).toBe(200);
  });

  it("refuses a bind without a session id", async () => {
    const socket = await start("bad1");
    const answer = await call(socket, "POST", "/bind", { transcriptPath: "/t/x.jsonl", source: "startup" });

    expect(answer).toEqual({ status: 400, json: { error: "bind needs sessionId, transcriptPath and source" } });
  });

  it("keeps the thread lease when it exits under a live Claude process, as a reload's old sidecar does", async () => {
    const socket = await start("lease1");
    await call(socket, "POST", "/bind", {
      sessionId: "s-lease",
      transcriptPath: "/t/s-lease.jsonl",
      source: "startup",
    });
    const threadId = ((await call(socket, "GET", "/health")).json as { recording: { threadId: string } }).recording
      .threadId;
    const running = child;
    const exited = new Promise((resolve) => running?.once("exit", resolve));
    running?.kill("SIGTERM");
    await exited;

    expect(acquireLease(home, threadId, process.ppid)).toEqual({ held: false, ownerPid: process.pid });
  });
});
