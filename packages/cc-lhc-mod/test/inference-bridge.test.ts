import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLhc, inspect, type Lhc, resolveTokenFamily, SUMMARY_WORKER_SYSTEM_PROMPT } from "lhc";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openRecording, type Recorder } from "../sidecar/src/capture/recorder.ts";
import {
  BRIDGE_CONCURRENCY,
  BRIDGE_PROVIDER,
  type Bridge,
  createBridge,
  laneAssignments,
} from "../sidecar/src/inference-bridge.ts";
import { createSidecarServer } from "../sidecar/src/server.ts";
import type { BridgeOutcome, BridgeRequest } from "../src/inference.ts";
import { Script, SESSION } from "./fixture.ts";

const LEASE_MS = 120_000;
const TIMEOUT_MS = 90_000;

let home: string;
let closers: Array<() => Promise<void>>;
const log: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-lhc-mod-bridge-"));
  closers = [];
});
afterEach(async () => {
  for (const close of closers) await close();
  rmSync(home, { recursive: true, force: true });
});

function lhcOn(bridge: Bridge, clock?: () => Date): Lhc {
  return initLhc({
    mode: "manual",
    inference: { call: bridge.call, assignments: laneAssignments(BRIDGE_PROVIDER), timeoutMs: TIMEOUT_MS },
    tokenFamily: resolveTokenFamily("", "anthropic").family,
    lease: { durationMs: LEASE_MS },
    ...(clock === undefined ? {} : { clock }),
  });
}

type Sidecar = { recorder: Recorder; post: (path: string, body: unknown) => Promise<Record<string, unknown>> };

async function sidecar(name: string, clock?: () => Date): Promise<Sidecar> {
  const bridge = createBridge(TIMEOUT_MS, (line) => log.push(line));
  const lhc = lhcOn(bridge, clock);
  const deps = { lhc, bridge, home, ownerPid: process.pid, log: (line: string) => log.push(line) };
  const recording = await openRecording(deps, {
    sessionId: SESSION,
    transcriptPath: join(home, `${SESSION}.jsonl`),
    source: "startup",
  });
  if (recording.kind !== "recording") throw new Error(recording.notice);
  const { server } = createSidecarServer(deps);
  const socketPath = join(home, `${name}.sock`);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  const post: Sidecar["post"] = (path, body) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, method: "POST", path }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk;
        });
        res.on("end", () => resolve(JSON.parse(text) as Record<string, unknown>));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  return { recorder: recording.recorder, post };
}

async function claim(side: Sidecar): Promise<BridgeRequest[]> {
  return (await side.post("/inference/claim", {})).requests as BridgeRequest[];
}

const answer = (side: Sidecar, id: string, outcome: BridgeOutcome) => side.post("/inference/result", { id, outcome });

async function pump(side: Sidecar, drained: Promise<unknown>, outcomeFor: (request: BridgeRequest) => BridgeOutcome) {
  let isDrained = false;
  void drained.then(() => {
    isDrained = true;
  });
  const seen: BridgeRequest[] = [];
  while (!isDrained) {
    const requests = await claim(side);
    for (const request of requests) {
      seen.push(request);
      await answer(side, request.id, outcomeFor(request));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return seen;
}

const counts = (recorder: Recorder) => countsOf(recorder.thread);

async function countsOf(thread: { threadId: string; registryPath: string }) {
  const report = await inspect.health(thread);
  if (!report.ok) throw new Error(report.error.reason);
  return report.value.owners.reduce(
    (sum, owner) => ({
      ready: sum.ready + owner.counts.ready,
      pending: sum.pending + owner.counts.pending,
      failed: sum.failed + owner.counts.failed,
    }),
    { ready: 0, pending: 0, failed: 0 },
  );
}

async function recordSession(recorder: Recorder): Promise<void> {
  const script = new Script();
  script.toolTurn("turn-1", "find the config file", "toolu_a");
  script.toolTurn("turn-2", "now explain what it sets", "toolu_b");
  writeFileSync(recorder.binding.transcriptPath, script.lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  await recorder.capture(script.entries);
}

const summary = (request: BridgeRequest): BridgeOutcome => ({ isAnswered: true, text: `summary for ${request.id}` });

it("hands core's own prompt to the pump and lands every derivation ready from its answers", async () => {
  const side = await sidecar("answer");
  await recordSession(side.recorder);

  const seen = await pump(side, side.recorder.deps.lhc.work.drain(side.recorder.thread), summary);

  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]).toMatchObject({
    model: "sonnet",
    system: SUMMARY_WORKER_SYSTEM_PROMPT,
    maxTokens: 32_000,
    effort: "low",
  });
  expect(seen.some((request) => request.prompt.includes("find the config file"))).toBe(true);
  expect(await counts(side.recorder)).toMatchObject({ pending: 0, failed: 0, ready: expect.any(Number) });
  expect((await counts(side.recorder)).ready).toBeGreaterThan(0);
});

it("puts an aborted completion back in the queue instead of failing it", async () => {
  const side = await sidecar("abort");
  await recordSession(side.recorder);
  const aborted = new Set<string>();

  const seen = await pump(side, side.recorder.deps.lhc.work.drain(side.recorder.thread), (request) => {
    if (aborted.size > 0) return summary(request);
    aborted.add(request.id);
    return { isAnswered: false, reason: "aborted" };
  });

  const [id] = aborted;
  expect(seen.filter((request) => request.id === id)).toHaveLength(2);
  expect(log).toContain(`bridge ${id} aborted, back in the queue`);
  expect(await counts(side.recorder)).toMatchObject({ pending: 0, failed: 0 });
});

const main = join(import.meta.dirname, "..", "sidecar", "src", "main.ts");

async function spawnSidecar(id: string): Promise<{ child: ChildProcess; post: Sidecar["post"] }> {
  const child = spawn(process.execPath, [main, "--home", home, "--id", id, "--inference", "bridge"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, LHC_NO_INFERENCE: "" },
  });
  closers.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  });
  const socketPath = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk;
      const match = /listening (\S+)/.exec(out);
      if (match?.[1] !== undefined) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`sidecar exited ${code}`)));
  });
  const post: Sidecar["post"] = (path, body) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, method: body === undefined ? "GET" : "POST", path }, (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk;
        });
        res.on("end", () => resolve(JSON.parse(text) as Record<string, unknown>));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { child, post };
}

async function threadOf(post: Sidecar["post"]): Promise<string> {
  const { recording } = (await post("/health", undefined)) as { recording: { threadId: string } };
  return recording.threadId;
}

async function claimOne(post: Sidecar["post"]): Promise<BridgeRequest> {
  for (;;) {
    const [first] = (await post("/inference/claim", {})).requests as BridgeRequest[];
    if (first !== undefined) return first;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it("reruns a completion a reload cut off, as soon as the reloaded sidecar binds", async () => {
  const script = new Script();
  script.toolTurn("turn-1", "find the config file", "toolu_a");
  const transcriptPath = join(home, `${SESSION}.jsonl`);
  writeFileSync(transcriptPath, script.lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const binding = { sessionId: SESSION, transcriptPath, source: "startup" };

  const before = await spawnSidecar("before");
  await before.post("/bind", binding);
  await before.post("/capture", { entries: script.entries });
  const cut = await claimOne(before.post);
  const exited = new Promise((resolve) => before.child.once("exit", resolve));
  before.child.kill("SIGTERM");
  await exited;

  const after = await spawnSidecar("after");
  await after.post("/bind", { ...binding, source: "reload" });
  const rerun = await claimOne(after.post);
  await after.post("/inference/result", { id: rerun.id, outcome: summary(rerun) });
  const thread = { threadId: await threadOf(after.post), registryPath: join(home, "registry.sqlite") };
  let health = await countsOf(thread);
  while (health.pending > 0) {
    const requests = (await after.post("/inference/claim", {})).requests as BridgeRequest[];
    for (const request of requests)
      await after.post("/inference/result", { id: request.id, outcome: summary(request) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    health = await countsOf(thread);
  }

  expect(rerun.prompt).toBe(cut.prompt);
  expect(health).toMatchObject({ pending: 0, failed: 0 });
}, 20_000);

it("reruns a completion a killed sidecar cut off, once its claim lease runs out", async () => {
  const before = await sidecar("before");
  await recordSession(before.recorder);
  void before.recorder.deps.lhc.work.drain(before.recorder.thread);
  let cut: BridgeRequest[] = [];
  while (cut.length === 0) cut = await claim(before);

  const later = () => new Date(Date.now() + LEASE_MS + 1000);
  const after = await sidecar("after", later);
  const seen = await pump(after, after.recorder.deps.lhc.work.drain(after.recorder.thread), summary);

  expect(seen[0]?.prompt).toBe(cut[0]?.prompt);
  expect(await counts(after.recorder)).toMatchObject({ pending: 0, failed: 0 });
});

it(`runs at most ${BRIDGE_CONCURRENCY} completions at once`, async () => {
  const bridge = createBridge(TIMEOUT_MS, () => {});
  const ask = { provider: BRIDGE_PROVIDER, model: "sonnet", messages: [{ role: "user" as const, content: "x" }] };
  const calls = Array.from({ length: BRIDGE_CONCURRENCY + 2 }, () => bridge.call(ask));

  const first = bridge.claim();
  expect(first).toHaveLength(BRIDGE_CONCURRENCY);
  expect(bridge.claim()).toHaveLength(0);
  bridge.answer({ id: first[0]?.id ?? "", outcome: { isAnswered: true, text: "done" } });
  expect(bridge.claim()).toHaveLength(1);

  await expect(calls[0]).resolves.toEqual({ ok: true, text: "done" });
});
