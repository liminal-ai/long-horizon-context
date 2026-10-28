#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const ENTRY = resolve(process.env.CLAUDE_LHC_SIDECAR ?? join(REPO, "packages/claude-lhc/dist/sidecar.js"));
const DIST = dirname(ENTRY);
const EVIDENCE = process.env.VERIFY_CLAUDE_LHC_EVIDENCE ?? mkdtempSync(join(tmpdir(), "verify-claude-lhc-evidence-"));
mkdirSync(EVIDENCE, { recursive: true });

class Scratch {
  constructor(label) {
    this.dir = mkdtempSync(join(tmpdir(), `verify-claude-lhc-${label}-`));
    this.lhcHome = join(this.dir, "t3code-lhc");
    this.claudeHome = join(this.dir, "claude-home");
    this.cwd = join(this.dir, "cwd");
    mkdirSync(this.cwd, { recursive: true });
  }
  threads() {
    const d = join(this.lhcHome, "threads");
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".sqlite")) : [];
  }
  projectedFiles() {
    const root = join(this.claudeHome, "projects");
    if (!existsSync(root)) return [];
    return readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
  }
  projected(sessionId) {
    const file = this.projectedFiles().find((f) => f.includes(sessionId));
    return file === undefined ? null : readFileSync(join(this.claudeHome, "projects", file), "utf8");
  }
  cleanup() {
    if (process.env.VERIFY_KEEP_SCRATCH !== "1") rmSync(this.dir, { recursive: true, force: true });
  }
}

class Sidecar {
  constructor(scratch, label) {
    this.label = label;
    this.frames = [];
    this.stderr = [];
    this.error = null;
    this.waiters = [];
    this.replies = new Map();
    this.nextId = 0;
    this.child = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        T3CODE_LHC_HOME: scratch.lhcHome,
        CLAUDE_CONFIG_DIR: scratch.claudeHome,
        T3CODE_LHC_NO_INFERENCE: "1",
      },
    });
    this.exited = new Promise((r) => this.child.on("exit", (code) => { this.exitCode = code; r(code); this.notify(); }));
    createInterface({ input: this.child.stderr }).on("line", (l) => { this.stderr.push(l); this.notify(); });
    createInterface({ input: this.child.stdout }).on("line", (l) => {
      const frame = JSON.parse(l);
      this.frames.push(frame);
      if (frame.type === "error") this.error = frame.message;
      if (frame.type === "res") this.replies.set(frame.id, frame);
      if (frame.type === "req") {
        this.send({ type: "res", id: frame.id, ok: true, value: frame.method === "canUseTool" ? { behavior: "allow", updatedInput: frame.params?.input } : {} });
      }
      this.notify();
    });
  }
  notify() { for (const f of this.waiters.splice(0)) f(); }
  send(frame) { this.child.stdin.write(`${JSON.stringify(frame)}\n`); }
  async waitFor(pred, what, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (this.error) throw new Error(`sidecar error while waiting for ${what}: ${this.error}`);
      if (this.exitCode !== undefined) throw new Error(`sidecar exited (${this.exitCode}) while waiting for ${what}`);
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, 500); });
    }
  }
  async request(method, params) {
    const id = ++this.nextId;
    const sentAt = performance.now();
    this.send({ type: "req", id, method, params });
    await this.waitFor(() => this.replies.has(id), `res to ${method}`);
    const reply = this.replies.get(id);
    if (!reply.ok) throw new Error(`${method} refused: ${reply.error}`);
    return { value: reply.value, ms: performance.now() - sentAt };
  }
  msgs() { return this.frames.filter((f) => f.type === "msg").map((f) => f.message); }
  logHas(text) { return this.stderr.some((l) => l.includes(text)); }
  async stop() {
    this.child.stdin.end();
    const code = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000))]);
    if (code === "timeout") this.child.kill("SIGKILL");
    return code;
  }
  saveEvidence(dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${this.label}.frames.jsonl`), this.frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    writeFileSync(join(dir, `${this.label}.stderr.log`), this.stderr.join("\n") + "\n");
  }
}

const baseOptions = (scratch, extra) => ({
  cwd: scratch.cwd,
  model: process.env.MODEL ?? "claude-sonnet-5",
  pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? "claude",
  systemPrompt: { type: "preset", preset: "claude_code" },
  settingSources: ["user", "project", "local"],
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  settings: { autoCompactWindow: 300000, lhcLowerBound: 180000 },
  env: { ...process.env, CLAUDE_CONFIG_DIR: scratch.claudeHome },
  ...extra,
});
const userFrame = (text) => ({
  type: "user",
  message: { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "" },
});
const generationFrom = (s) => /as generation (\S+)/.exec(s.stderr.join("\n"))?.[1];
const threadIdFrom = (s) => /created thread (\S+)|resumed thread (\S+)/.exec(s.stderr.join("\n"))?.slice(1).find(Boolean);

function assert(cond, reason) { if (!cond) throw new Error(reason); }

async function seedCompacted(scratch, evidenceDir) {
  const sid1 = randomUUID();
  const s = new Sidecar(scratch, "seed");
  s.send({ type: "start", options: baseOptions(scratch, { sessionId: sid1 }) });
  await s.waitFor(() => s.logHas(`as generation ${sid1}`), "created-thread log line");
  s.send(userFrame("/compact"));
  await s.waitFor(() => s.msgs().some((m) => m.type === "result"), "compact result frame");
  const boundary = s.msgs().find((m) => m.type === "system" && m.subtype === "compact_boundary");
  assert(boundary, "no compact_boundary after /compact");
  const sid2 = boundary.session_id;
  const code = await s.stop();
  s.saveEvidence(evidenceDir);
  assert(code === 0, `seed sidecar exited ${code}`);
  return { sid1, sid2, seed: s };
}

async function seedCaptured(scratch, turns) {
  process.env.T3CODE_LHC_NO_INFERENCE = "1";
  const home = await import(join(DIST, "lhcHome.js"));
  const mapper = await import(join(DIST, "capture/mapper.js"));
  const gen1 = randomUUID();
  const threadId = await home.createThread(scratch.cwd, scratch.lhcHome);
  await home.bindSession(threadId, gen1, scratch.lhcHome);
  const ref = home.threadRef(threadId, scratch.lhcHome);
  const lhc = home.createLhc({ claudeBin: "claude", env: {}, tokenFamily: "claude-2026" });
  const anchors = [];
  for (const [prompt, answer] of turns) {
    const uuid = randomUUID();
    const events = [
      ...mapper.mapPrompt(userFrame(prompt).message, randomUUID(), false),
      ...mapper.mapSdkMessage({ type: "assistant", uuid, parent_tool_use_id: null, session_id: gen1, message: { id: `msg_${uuid}`, model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: answer }] } }).events,
      ...mapper.mapSdkMessage({ type: "result", subtype: "success", is_error: false, uuid: randomUUID(), session_id: gen1 }).events,
    ];
    const sent = await lhc.intakeStream.messageEvents(ref, events);
    assert(sent.ok, `seed intake refused: ${sent.ok ? "" : sent.error.reason}`);
    anchors.push(uuid);
  }
  await lhc.drainSettled(ref);
  return { gen1, threadId, anchors };
}

const PA_TURNS = [["KEEP-TURN prompt one", "KEEP-TURN answer one"], ["REMOVED-TURN prompt two", "REMOVED-TURN answer two"]];
const FILLER = " filler".repeat(400);

async function startAndStop(scratch, label, options, evidenceDir) {
  const s = new Sidecar(scratch, label);
  s.send({ type: "start", options: baseOptions(scratch, options) });
  await s.waitFor(() => s.logHas("resumed thread") || s.logHas("created thread"), `${label} start log line`);
  const code = await s.stop();
  s.saveEvidence(evidenceDir);
  assert(code === 0, `${label} sidecar exited ${code}`);
  return { s, gen: generationFrom(s) };
}

async function compactOnce(scratch, label, options, evidenceDir) {
  const s = new Sidecar(scratch, label);
  s.send({ type: "start", options: baseOptions(scratch, options) });
  await s.waitFor(() => s.logHas("resumed thread"), `${label} resumed-thread log line`);
  s.send(userFrame("/compact"));
  await s.waitFor(() => s.msgs().some((m) => m.type === "result"), `${label} compact result frame`);
  const boundary = s.msgs().find((m) => m.type === "system" && m.subtype === "compact_boundary");
  const code = await s.stop();
  s.saveEvidence(evidenceDir);
  assert(code === 0, `${label} sidecar exited ${code}`);
  assert(boundary, `${label}: no compact_boundary after /compact`);
  return { s, gen: generationFrom(s), compacted: boundary.session_id };
}

async function startEchoMcp(name) {
  const require = createRequire(join(REPO, "packages/claude-lhc/package.json"));
  const { McpServer } = await import(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
  const { StreamableHTTPServerTransport } = await import(require.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"));
  const http = createServer(async (request, response) => {
    const server = new McpServer({ name, version: "1.0.0" });
    server.tool("ping", "Reply pong", async () => ({ content: [{ type: "text", text: `pong from ${name}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  return { config: { type: "http", url: `http://127.0.0.1:${http.address().port}/mcp` }, close: () => http.close() };
}

const mcpToolsOf = (turn) => {
  const init = turn.messages.find((m) => m.type === "system" && m.subtype === "init");
  assert(init, "the turn carried no system/init message");
  return init.tools.filter((t) => t.startsWith("mcp__")).sort();
};
const RETRIEVAL_TOOLS = ["mcp__lhc__get_messages", "mcp__lhc__get_turns"];
const LIVE_GATE = "needs a real model turn; set CLAUDE_LHC_LIVE=1 (isolated CLAUDE_CONFIG_DIR, auth from env)";

async function liveTurn(s, text) {
  const before = s.msgs().length;
  s.send(userFrame(text));
  await s.waitFor(() => s.msgs().slice(before).some((m) => m.type === "result"), `result for "${text}"`, 180_000);
  const turn = s.msgs().slice(before);
  const assistants = turn.filter((m) => m.type === "assistant" && m.parent_tool_use_id === null);
  return { messages: turn, result: turn.find((m) => m.type === "result"), lastAssistantUuid: assistants.at(-1)?.uuid };
}

const drives = {
  async start(evidenceDir) {
    const scratch = new Scratch("start");
    try {
      const sid = randomUUID();
      const s = new Sidecar(scratch, "start");
      s.send({ type: "start", options: baseOptions(scratch, { sessionId: sid }) });
      await s.waitFor(() => s.logHas(`as generation ${sid}`), "created-thread log line");
      const code = await s.stop();
      s.saveEvidence(evidenceDir);
      assert(code === 0, `sidecar exited ${code} on stdin close`);
      assert(existsSync(join(scratch.lhcHome, "registry.sqlite")), "registry.sqlite missing");
      assert(scratch.threads().length === 1, `expected 1 thread file, got ${scratch.threads().length}`);
      return `thread=${threadIdFrom(s)} generation=${sid} exit=0 threads=1`;
    } finally { scratch.cleanup(); }
  },

  async compact(evidenceDir) {
    const scratch = new Scratch("compact");
    try {
      const { sid1, sid2, seed } = await seedCompacted(scratch, evidenceDir);
      assert(sid2 !== sid1, "compact did not mint a new session id");
      const seq = seed.msgs().map((m) =>
        m.type === "system" && m.subtype === "status" ? `status:${m.status ?? "null"}${m.compact_result ? ":" + m.compact_result : ""}`
        : m.type === "system" && m.subtype === "compact_boundary" ? "boundary"
        : m.type === "result" ? "result" : null).filter(Boolean);
      assert(JSON.stringify(seq) === JSON.stringify(["status:compacting", "status:null:success", "boundary", "result"]),
        `compact frame order ${JSON.stringify(seq)}`);
      assert(scratch.projectedFiles().some((f) => f.includes(sid2)), `no projected file for ${sid2}`);
      assert(scratch.threads().length === 1, "store does not hold exactly one thread");
      return `order=${seq.join(">")} gen1=${sid1.slice(0, 8)} gen2=${sid2.slice(0, 8)} projected=yes threads=1 (empty view; proves boundary/projection plumbing, not summarization)`;
    } finally { scratch.cleanup(); }
  },

  async restart(evidenceDir) {
    const scratch = new Scratch("restart");
    try {
      const { sid2 } = await seedCompacted(scratch, evidenceDir);
      const before = scratch.threads().length;
      const s = new Sidecar(scratch, "restart");
      s.send({ type: "start", options: baseOptions(scratch, { resume: sid2 }) });
      await s.waitFor(() => s.logHas(`resumed thread`), "resumed-thread log line");
      const gen3 = /as generation (\S+)/.exec(s.stderr.join("\n"))?.[1];
      const code = await s.stop();
      s.saveEvidence(evidenceDir);
      assert(code === 0, `restart sidecar exited ${code}`);
      assert(gen3 && gen3 !== sid2, "restart did not mint a new generation");
      assert(s.logHas(`via ${sid2}`), "resume did not go through the gen2 alias");
      assert(scratch.projectedFiles().some((f) => f.includes(gen3)), `no projected file for gen3 ${gen3}`);
      const lines = readFileSync(join(scratch.claudeHome, "projects", scratch.projectedFiles().find((f) => f.includes(gen3))), "utf8").trim().split("\n").filter(Boolean).length;
      assert(scratch.threads().length === before, "restart created a second thread");
      return `resumed via gen2 as gen3=${gen3.slice(0, 8)} projectedLines>=1(file lines=${lines}) threads=${before} exit=0`;
    } finally { scratch.cleanup(); }
  },

  async "resume-superseded-alias"(evidenceDir) {
    const scratch = new Scratch("resume-superseded-alias");
    try {
      const { sid1, sid2, seed } = await seedCompacted(scratch, evidenceDir);
      const thread = threadIdFrom(seed);
      const s = new Sidecar(scratch, "resume-superseded-alias");
      s.send({ type: "start", options: baseOptions(scratch, { resume: sid1 }) });
      await s.waitFor(() => s.logHas("resumed thread"), "resumed-thread log line");
      const genN = /as generation (\S+)/.exec(s.stderr.join("\n"))?.[1];
      const code = await s.stop();
      s.saveEvidence(evidenceDir);
      assert(code === 0, `rollback-shaped sidecar exited ${code}`);
      assert(s.logHas(`resumed thread ${thread} via ${sid1}`), "old alias did not resolve to the same thread");
      assert(genN && genN !== sid1 && genN !== sid2, "rollback-shaped start did not mint a fresh generation");
      assert(scratch.projectedFiles().some((f) => f.includes(genN)), "no projected file for the new generation");
      assert(scratch.threads().length === 1, "rollback-shaped start forked the store");
      return `resume:gen1(${sid1.slice(0, 8)}) -> same thread ${thread} as fresh gen=${genN.slice(0, 8)} threads=1; OBSERVED: current served view, not gen1-era history`;
    } finally { scratch.cleanup(); }
  },

  async "resume-unknown"(evidenceDir) {
    const scratch = new Scratch("resume-unknown");
    try {
      const s = new Sidecar(scratch, "resume-unknown");
      s.send({ type: "start", options: baseOptions(scratch, { resume: randomUUID() }) });
      const code = await s.exited;
      s.saveEvidence(evidenceDir);
      assert(code === 1, `expected exit 1, got ${code}`);
      assert(s.error?.includes("no LHC thread holds the Claude session"), `unexpected error frame: ${s.error}`);
      assert(scratch.threads().length === 0, "unknown resume created a thread");
      return `exit=1 error="no LHC thread holds the Claude session" threads=0`;
    } finally { scratch.cleanup(); }
  },

  async rollback(evidenceDir) {
    const scratch = new Scratch("rollback");
    try {
      const { gen1, threadId, anchors } = await seedCaptured(scratch, PA_TURNS);
      const { s, gen } = await startAndStop(scratch, "rollback", { resume: gen1, resumeSessionAt: anchors[0] }, evidenceDir);
      const projected = scratch.projected(gen) ?? "";
      writeFileSync(join(evidenceDir, "projected.jsonl"), projected);
      assert(projected.includes("KEEP-TURN answer one"), "projected file lost the kept turn");
      assert(!projected.includes("REMOVED-TURN"), "projected file still carries the removed turn: the host rollback was ignored");
      assert(s.logHas(`rollback to ${anchors[0]}: kept through event`), "no rollback log line");
      assert(scratch.threads().length === 1, "rollback forked the store");
      return `resume:gen1 resumeSessionAt:keep-anchor -> thread ${threadId} gen=${gen.slice(0, 8)} projected keep=yes removed=no threads=1`;
    } finally { scratch.cleanup(); }
  },

  async "rollback-unknown-anchor"(evidenceDir) {
    const scratch = new Scratch("rollback-unknown-anchor");
    try {
      const { gen1 } = await seedCaptured(scratch, PA_TURNS);
      const unknown = randomUUID();
      const s = new Sidecar(scratch, "rollback-unknown-anchor");
      s.send({ type: "start", options: baseOptions(scratch, { resume: gen1, resumeSessionAt: unknown }) });
      const code = await s.exited;
      s.saveEvidence(evidenceDir);
      assert(code === 1, `expected exit 1, got ${code}`);
      assert(s.error?.includes(`rollback to ${unknown} refused`), `unexpected error frame: ${s.error}`);
      assert(scratch.projectedFiles().length === 0, "a refused rollback still projected a file");
      return `resumeSessionAt:${unknown.slice(0, 8)} (in no transcript) -> exit=1 error="rollback ... refused", nothing projected`;
    } finally { scratch.cleanup(); }
  },

  async "rollback-synthetic-anchor"(evidenceDir) {
    const scratch = new Scratch("rollback-synthetic-anchor");
    try {
      const { gen1, anchors } = await seedCaptured(scratch, PA_TURNS);
      const native = await import(join(DIST, "nativeSessionFile.js"));
      const synthetic = randomUUID();
      const lines = [
        ["user", randomUUID(), PA_TURNS[0][0]],
        ["assistant", anchors[0], PA_TURNS[0][1]],
        ["user", randomUUID(), "FAILED prompt"],
        ["assistant", synthetic, "API Error: 401", "<synthetic>"],
        ["user", randomUUID(), PA_TURNS[1][0]],
        ["assistant", anchors[1], PA_TURNS[1][1]],
      ].map(([type, uuid, text, model], i, all) =>
        JSON.stringify({ parentUuid: i === 0 ? null : all[i - 1][1], isSidechain: false, type, uuid, sessionId: gen1, message: { role: type, content: [{ type: "text", text }], ...(model ? { model } : {}) } }));
      const file = native.nativeSessionPath({ sessionId: gen1, cwd: scratch.cwd, env: { CLAUDE_CONFIG_DIR: scratch.claudeHome } });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${lines.join("\n")}\n`);
      const { s, gen } = await startAndStop(scratch, "rollback", { resume: gen1, resumeSessionAt: synthetic }, evidenceDir);
      assert(s.logHas(`rollback to ${synthetic}: kept through event`) && s.logHas(`at nearest captured ancestor ${anchors[0]}`), "the synthetic anchor did not resolve to the kept assistant message");
      const { compacted } = await compactOnce(scratch, "compact", { resume: gen }, evidenceDir);
      const { gen: restarted } = await startAndStop(scratch, "restart", { resume: compacted }, evidenceDir);
      const files = { rollback: scratch.projected(gen) ?? "", compact: scratch.projected(compacted) ?? "", restart: scratch.projected(restarted) ?? "" };
      for (const [label, text] of Object.entries(files)) {
        writeFileSync(join(evidenceDir, `${label}.projected.jsonl`), text);
        assert(!text.includes("REMOVED-TURN"), `${label} projected file carries the removed turn`);
      }
      assert(files.rollback.includes("KEEP-TURN answer one"), "the rollback projection lost the kept turn");
      return `resumeSessionAt:<synthetic notice> -> kept through its nearest captured ancestor; removed text absent after start, /compact, restart`;
    } finally { scratch.cleanup(); }
  },

  async "rollback-compact"(evidenceDir) {
    const scratch = new Scratch("rollback-compact");
    try {
      const turns = [
        ...Array.from({ length: 8 }, (_, i) => [`KEEP-TURN prompt ${i}${FILLER}`, `KEEP-TURN answer ${i}${FILLER}`]),
        ...Array.from({ length: 4 }, (_, i) => [`REMOVED-TURN prompt ${i}${FILLER}`, `REMOVED-TURN answer ${i}${FILLER}`]),
      ];
      const { gen1, anchors } = await seedCaptured(scratch, turns);
      const small = { settings: { autoCompactWindow: 2000, lhcLowerBound: 1000 } };
      const seed = await compactOnce(scratch, "seed-compact", { ...small, resume: gen1 }, evidenceDir);
      const rolled = new Sidecar(scratch, "rollback-start");
      rolled.send({ type: "start", options: baseOptions(scratch, { ...small, resume: seed.compacted, resumeSessionAt: anchors[1] }) });
      await rolled.waitFor(() => rolled.logHas("resumed thread"), "rollback resumed-thread log line");
      const genAfterRollback = generationFrom(rolled);
      rolled.send(userFrame("/compact"));
      await rolled.waitFor(() => rolled.msgs().some((m) => m.type === "result"), "post-rollback compact result");
      const genAfterCompact = rolled.msgs().find((m) => m.type === "system" && m.subtype === "compact_boundary")?.session_id;
      assert((await rolled.stop()) === 0, "rollback sidecar did not exit 0");
      rolled.saveEvidence(evidenceDir);
      assert(rolled.logHas("[lhc compact:auto]"), "the rollback behind the compact point did not compact before projecting");
      assert(genAfterCompact, "no compact_boundary after the post-rollback /compact");
      const { gen: genAfterRestart } = await startAndStop(scratch, "restart", { ...small, resume: genAfterCompact }, evidenceDir);
      const checks = { rollback: genAfterRollback, compact: genAfterCompact, restart: genAfterRestart };
      for (const [step, gen] of Object.entries(checks)) {
        const projected = scratch.projected(gen);
        assert(projected !== null, `no projected file after ${step}`);
        writeFileSync(join(evidenceDir, `${step}.projected.jsonl`), projected);
        assert(!projected.includes("REMOVED-TURN"), `removed text came back after ${step}`);
        assert(!projected.includes("KEEP-TURN answer 2"), `text past the anchor came back after ${step}`);
      }
      return "rollback behind the compact point -> compact at start, /compact, restart; removed text absent from all 3 projected files";
    } finally { scratch.cleanup(); }
  },

  async "thread-start"(evidenceDir) {
    const scratch = new Scratch("thread-start");
    try {
      const { gen1, threadId } = await seedCaptured(scratch, PA_TURNS);
      const fresh = randomUUID();
      const started = await startAndStop(scratch, "fresh-start", { sessionId: fresh }, evidenceDir);
      const newThread = threadIdFrom(started.s);
      assert(newThread && newThread !== threadId, "a fresh session id did not open a new thread");
      const old = await startAndStop(scratch, "old-alias", { resume: gen1 }, evidenceDir);
      assert(old.s.logHas(`resumed thread ${threadId} via ${gen1}`), "the old thread is no longer reachable by its alias");
      const reused = new Sidecar(scratch, "reused-id");
      reused.send({ type: "start", options: baseOptions(scratch, { sessionId: gen1 }) });
      const code = await reused.exited;
      reused.saveEvidence(evidenceDir);
      assert(code === 1, `reused id: expected exit 1, got ${code}`);
      assert(reused.error?.includes(`already names LHC thread ${threadId}`), `reused id: unexpected error ${reused.error}`);
      assert(scratch.threads().length === 2, `expected 2 threads, got ${scratch.threads().length}`);
      return `fresh id -> new thread ${newThread}; old alias -> ${threadId}; reused id refused (exit 1); threads=2`;
    } finally { scratch.cleanup(); }
  },

  async "resume-empty"(evidenceDir) {
    const scratch = new Scratch("resume-empty");
    try {
      const sid = randomUUID();
      await startAndStop(scratch, "seed", { sessionId: sid }, evidenceDir);
      const { s, gen } = await startAndStop(scratch, "resume-empty", { resume: sid }, evidenceDir);
      assert(s.logHas("(fresh native session)"), "an empty thread was not started as a fresh native session");
      assert(scratch.projected(gen) === null, "an empty projected file was written");
      assert(scratch.threads().length === 1, "resume-empty created a second thread");
      return `empty thread resumed as fresh native session gen=${gen.slice(0, 8)} exit=0 threads=1`;
    } finally { scratch.cleanup(); }
  },

  async "start-mcp"(evidenceDir) {
    if (process.env.CLAUDE_LHC_LIVE !== "1") return { skip: LIVE_GATE };
    const scratch = new Scratch("start-mcp");
    const echo = await startEchoMcp("echo");
    try {
      const s = new Sidecar(scratch, "start-mcp");
      s.send({ type: "start", options: baseOptions(scratch, { sessionId: randomUUID(), mcpServers: { echo: echo.config } }) });
      await s.waitFor(() => s.logHas("created thread"), "created-thread log line");
      const turn = await liveTurn(s, "Reply with just OK.");
      assert((await s.stop()) === 0, "start-mcp sidecar did not exit 0");
      s.saveEvidence(evidenceDir);
      const tools = mcpToolsOf(turn);
      writeFileSync(join(evidenceDir, "tools.json"), `${JSON.stringify(tools, null, 2)}\n`);
      assert(turn.result?.subtype === "success", `the turn failed: ${JSON.stringify(turn.result)}`);
      for (const tool of ["mcp__echo__ping", ...RETRIEVAL_TOOLS]) assert(tools.includes(tool), `the turn lacks ${tool}: ${tools.join(", ")}`);
      return `start-frame MCP tools in the turn: ${tools.join(", ")}`;
    } finally { echo.close(); scratch.cleanup(); }
  },

  async "late-mcp"(evidenceDir) {
    if (process.env.CLAUDE_LHC_LIVE !== "1") return { skip: LIVE_GATE };
    const scratch = new Scratch("late-mcp");
    const start = await startEchoMcp("start");
    const late = await startEchoMcp("late");
    const other = await startEchoMcp("other");
    try {
      const s = new Sidecar(scratch, "late-mcp");
      s.send({ type: "start", options: baseOptions(scratch, { sessionId: randomUUID(), mcpServers: { start: start.config } }) });
      const first = await s.request("setMcpServers", { servers: { late: late.config } });
      assert(first.value.added.includes("late") && Object.keys(first.value.errors).length === 0, `first set: ${JSON.stringify(first.value)}`);
      const turn = await liveTurn(s, "Reply with just OK.");
      const tools = mcpToolsOf(turn);
      const compacted = await liveTurn(s, "/compact");
      const afterCompact = await liveTurn(s, "Reply with just OK again.");
      const compactTools = mcpToolsOf(afterCompact);
      const second = await s.request("setMcpServers", { servers: { other: other.config } });
      assert((await s.stop()) === 0, "late-mcp sidecar did not exit 0");
      s.saveEvidence(evidenceDir);
      writeFileSync(join(evidenceDir, "tools.json"), `${JSON.stringify({ tools, compactTools, first, second }, null, 2)}\n`);
      assert(turn.result?.subtype === "success", `the turn failed: ${JSON.stringify(turn.result)}`);
      for (const tool of ["mcp__start__ping", "mcp__late__ping", ...RETRIEVAL_TOOLS]) assert(tools.includes(tool), `the turn lacks ${tool}: ${tools.join(", ")}`);
      const boundary = compacted.messages.find((m) => m.type === "system" && m.subtype === "compact_boundary");
      assert(boundary, "/compact emitted no compact_boundary");
      assert(afterCompact.result?.session_id === boundary.session_id, "the turn after /compact did not run in the new generation");
      assert(JSON.stringify(compactTools) === JSON.stringify(tools), `the new generation lost the late set: ${compactTools.join(", ")}`);
      assert(second.value.added.includes("other") && second.value.removed.includes("late"), `the second set did not replace the first: ${JSON.stringify(second.value)}`);
      assert(!second.value.removed.includes("lhc") && !second.value.removed.includes("start"), `the second set removed a server it does not own: ${JSON.stringify(second.value)}`);
      return `late set applied in ${first.ms.toFixed(0)} ms; turn tools: ${tools.join(", ")}; same tools after /compact in generation ${boundary.session_id.slice(0, 8)}; second set ${JSON.stringify(second.value)} in ${second.ms.toFixed(0)} ms`;
    } finally { start.close(); late.close(); other.close(); scratch.cleanup(); }
  },

  async "rollback-live"(evidenceDir) {
    if (process.env.CLAUDE_LHC_LIVE !== "1") return { skip: LIVE_GATE };
    const scratch = new Scratch("rollback-live");
    try {
      const gen1 = randomUUID();
      const first = new Sidecar(scratch, "turns");
      first.send({ type: "start", options: baseOptions(scratch, { sessionId: gen1 }) });
      await first.waitFor(() => first.logHas(`as generation ${gen1}`), "created-thread log line");
      const kept = await liveTurn(first, "Remember the codeword KEEP-ALPHA. Reply with just OK.");
      const removed = await liveTurn(first, "Remember the second codeword REMOVED-BRAVO. Reply with just OK.");
      assert((await first.stop()) === 0, "turn sidecar did not exit 0");
      first.saveEvidence(evidenceDir);
      assert(kept.result?.subtype === "success" && removed.result?.subtype === "success", "a seed turn failed");
      assert(kept.lastAssistantUuid, "no assistant uuid on the kept turn");
      const after = new Sidecar(scratch, "after-rollback");
      after.send({ type: "start", options: baseOptions(scratch, { resume: gen1, resumeSessionAt: kept.lastAssistantUuid }) });
      let ask;
      try {
        await after.waitFor(() => after.logHas("resumed thread"), "resumed-thread log line");
        ask = await liveTurn(after, "List every codeword in capitals that appears earlier in this conversation, comma separated, nothing else.");
        assert((await after.stop()) === 0, "rollback sidecar did not exit 0");
      } finally {
        after.saveEvidence(evidenceDir);
      }
      const answer = String(ask.result?.result ?? "");
      writeFileSync(join(evidenceDir, "answer.txt"), `${JSON.stringify(ask.result, null, 2)}\n`);
      assert(ask.result?.subtype === "success" && ask.result.is_error !== true, `the continued turn failed: ${JSON.stringify(ask.result?.errors ?? answer)}`);
      assert(answer.includes("KEEP-ALPHA"), `the continued answer lost the kept turn: ${answer}`);
      assert(!answer.includes("REMOVED-BRAVO"), `the continued answer knows the removed turn: ${answer}`);
      return `rolled back to ${kept.lastAssistantUuid.slice(0, 8)}; continued answer "${answer.trim()}"`;
    } finally { scratch.cleanup(); }
  },

  async turn() {
    if (process.env.CLAUDE_LHC_LIVE !== "1") {
      return { skip: "needs a real model turn; set CLAUDE_LHC_LIVE=1 and use packages/claude-lhc/scripts/standalone.ts (real CLAUDE_CONFIG_DIR login, isolated T3CODE_LHC_HOME)" };
    }
    throw new Error("live turn is driven by packages/claude-lhc/scripts/standalone.ts, not reimplemented here; run: pnpm --filter claude-lhc standalone");
  },
};

async function main() {
  if (!existsSync(ENTRY)) {
    console.log(`VERIFY-CLAUDE-LHC preflight: FAIL dist missing (${ENTRY}); build: pnpm --filter lhc build && pnpm --filter claude-lhc build`);
    process.exit(1);
  }
  const which = process.argv[2] ?? "all";
  const names =
    which === "all"
      ? ["start", "compact", "restart", "resume-superseded-alias", "resume-unknown", "resume-empty", "rollback", "rollback-unknown-anchor", "rollback-synthetic-anchor", "rollback-compact", "thread-start", "turn", "rollback-live", "start-mcp", "late-mcp"]
      : [which];
  const summary = { evidence: EVIDENCE, startedAt: new Date().toISOString(), drives: {} };
  let failed = false;
  for (const name of names) {
    const fn = drives[name];
    if (!fn) { console.log(`VERIFY-CLAUDE-LHC ${name}: FAIL unknown drive`); failed = true; continue; }
    const dir = join(EVIDENCE, name);
    const t0 = Date.now();
    try {
      const detail = await fn(dir);
      if (detail?.skip) {
        console.log(`VERIFY-CLAUDE-LHC ${name}: SKIP ${detail.skip}`);
        summary.drives[name] = { status: "skip", detail: detail.skip, ms: Date.now() - t0 };
      } else {
        console.log(`VERIFY-CLAUDE-LHC ${name}: PASS ${detail} (${Date.now() - t0}ms)`);
        summary.drives[name] = { status: "pass", detail, ms: Date.now() - t0 };
      }
    } catch (cause) {
      failed = true;
      console.log(`VERIFY-CLAUDE-LHC ${name}: FAIL ${cause instanceof Error ? cause.message : String(cause)} (${Date.now() - t0}ms)`);
      summary.drives[name] = { status: "fail", detail: String(cause), ms: Date.now() - t0 };
    }
  }
  summary.finishedAt = new Date().toISOString();
  writeFileSync(join(EVIDENCE, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`VERIFY-CLAUDE-LHC evidence: ${EVIDENCE}`);
  process.exit(failed ? 1 : 0);
}
await main();
