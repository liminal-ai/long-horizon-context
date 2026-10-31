#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const ENTRY = join(REPO, "packages/claude-lhc/dist/sidecar.js");
const DIST = dirname(ENTRY);
const MAIN = (() => {
  try {
    return execFileSync("git", ["-C", REPO, "worktree", "list", "--porcelain"], { encoding: "utf8" }).match(/^worktree (.+)$/m)[1];
  } catch {
    return REPO;
  }
})();
const RUN = process.env.VERIFY_RUN_DIR ?? join(MAIN, ".pstack/runs/verify-claude-lhc");
const SCRATCH_ROOT = process.env.VERIFY_SCRATCH_ROOT ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "verify-claude-lhc/scratch");
mkdirSync(SCRATCH_ROOT, { recursive: true });
for (let d = realpathSync(SCRATCH_ROOT); ; d = dirname(d)) {
  const found = ["CLAUDE.md", "AGENTS.md"].map((f) => join(d, f)).find(existsSync);
  if (found) {
    console.log(`VERIFY-CLAUDE-LHC preflight: FAIL scratch root ${SCRATCH_ROOT} sits under ${found}; Claude would load it from the session cwd. Set VERIFY_SCRATCH_ROOT outside any repo.`);
    process.exit(1);
  }
  if (d === dirname(d)) break;
}
mkdirSync(join(RUN, "proof"), { recursive: true });
const EVIDENCE = process.env.VERIFY_CLAUDE_LHC_EVIDENCE ?? mkdtempSync(join(RUN, "proof", "evidence-"));
mkdirSync(EVIDENCE, { recursive: true });

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

// The claude CLI a sidecar spawns can still write claude-home/.claude.json after the sidecar exits.
function waitForGroupExit(pgid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) return;
    Atomics.wait(PAUSE, 0, 0, 50);
  }
}

class Scratch {
  constructor(label) {
    this.groups = [];
    this.dir = mkdtempSync(join(SCRATCH_ROOT, `verify-claude-lhc-${label}-`));
    this.lhcHome = join(this.dir, "lhc");
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
    for (const pgid of this.groups) waitForGroupExit(pgid);
    if (process.env.VERIFY_KEEP_SCRATCH === "1") console.log(`VERIFY-CLAUDE-LHC kept scratch: ${this.dir}`);
    else rmSync(this.dir, { recursive: true, force: true });
  }
}

class Sidecar {
  constructor(scratch, label, { live = false } = {}) {
    this.label = label;
    this.frames = [];
    this.stderr = [];
    this.error = null;
    this.waiters = [];
    const env = { ...process.env, CLAUDE_CONFIG_DIR: scratch.claudeHome, CLAUDE_LHC_NO_INFERENCE: "1" };
    if (live) {
      delete env.CLAUDE_LHC_NO_INFERENCE;
      env.HOME = scratch.home;
    }
    this.child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env, detached: true });
    scratch.groups.push(this.child.pid);
    this.exited = new Promise((r) => this.child.on("exit", (code) => { this.exitCode = code; r(code); this.notify(); }));
    createInterface({ input: this.child.stderr }).on("line", (l) => { this.stderr.push(l); this.notify(); });
    createInterface({ input: this.child.stdout }).on("line", (l) => {
      const frame = JSON.parse(l);
      this.frames.push(frame);
      if (frame.type === "error") this.error = frame.message;
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
  msgs() { return this.frames.filter((f) => f.type === "msg").map((f) => f.message); }
  async control(id, method, params) {
    this.send({ type: "req", id, method, params });
    await this.waitFor(() => this.frames.some((f) => f.type === "res" && f.id === id), `${method} response`);
    return this.frames.find((f) => f.type === "res" && f.id === id);
  }
  logHas(text) { return this.stderr.some((l) => l.includes(text)); }
  async stop() {
    this.child.stdin.end();
    const code = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000))]);
    if (code === "timeout") {
      try { process.kill(-this.child.pid, "SIGKILL"); } catch {}
    }
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
  lhc: { home: scratch.lhcHome, compact: { trigger: 300000, target: 180000 } },
  env: { ...process.env, CLAUDE_CONFIG_DIR: scratch.claudeHome },
  ...extra,
});
const userFrame = (text, uuid) => ({
  type: "user",
  message: { type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: "", ...(uuid ? { uuid } : {}) },
});
const generationFrom = (s) => /as generation (\S+)/.exec(s.stderr.join("\n"))?.[1];
const threadIdFrom = (s) => /created thread (\S+)|resumed thread (\S+)/.exec(s.stderr.join("\n"))?.slice(1).find(Boolean);

function assert(cond, reason) { if (!cond) throw new Error(reason); }

const LIVE_AUTH_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];

async function seedCompacted(scratch, evidenceDir, extra = {}, ready = (s, sid1) => s.logHas(`as generation ${sid1}`)) {
  const sid1 = randomUUID();
  const s = new Sidecar(scratch, "seed");
  s.send({ type: "start", options: baseOptions(scratch, { sessionId: sid1, ...extra }) });
  await s.waitFor(() => ready(s, sid1), "created-thread log line");
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
  process.env.CLAUDE_LHC_NO_INFERENCE = "1";
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
  const eventCount = async () => {
    const keys = await lhc.intakeStream.listEventKeysByPrefix(ref, { prefix: "claude-lhc:" });
    assert(keys.ok, `event key read failed: ${keys.ok ? "" : keys.error.reason}`);
    return keys.value.keys.length;
  };
  return { gen1, threadId, anchors, eventCount };
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

async function compactNow(s) {
  const before = s.msgs().length;
  s.send(userFrame("/compact"));
  await s.waitFor(() => s.msgs().slice(before).some((m) => m.type === "result"), "compact result frame", 180_000);
  const boundary = s.msgs().slice(before).find((m) => m.type === "system" && m.subtype === "compact_boundary");
  assert(boundary, "no compact_boundary after /compact");
  return boundary.session_id;
}

const lateServer = (res) => (res.ok ? res.value : []).find((server) => server.name === "late");
const REFUSED_CONTROLS = { rewindFiles: { userMessageId: randomUUID() }, reinitialize: {}, seedReadState: { path: "a.txt", mtime: 1 } };
const FLAG_MODEL = "claude-sonnet-4-6";

async function callInScratchEnv(scratch, fn, args, { live = false } = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: scratch.claudeHome, CLAUDE_LHC_NO_INFERENCE: "1" };
  if (live) {
    delete env.CLAUDE_LHC_NO_INFERENCE;
    env.HOME = scratch.home;
  }
  const entry = JSON.stringify(pathToFileURL(join(DIST, "index.js")).href);
  const script = `const lib = await import(${entry}); process.stdout.write(JSON.stringify(await lib[${JSON.stringify(fn)}](...${JSON.stringify(args)})));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: scratch.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  scratch.groups.push(child.pid);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((r) => child.on("exit", r));
  return { code, stderr, value: code === 0 ? JSON.parse(stdout) : undefined, error: /Error: (.+)/.exec(stderr)?.[1] };
}

function threadRows(scratch) {
  const registry = new DatabaseSync(join(scratch.lhcHome, "registry.sqlite"), { readOnly: true });
  const threads = registry.prepare("SELECT thread_id, file_path FROM threads ORDER BY created_at").all();
  const aliases = registry.prepare("SELECT alias, thread_id FROM thread_alias ORDER BY alias").all();
  registry.close();
  return {
    threads: threads.map(({ thread_id, file_path }) => {
      const db = new DatabaseSync(file_path, { readOnly: true });
      const row = db.prepare("SELECT compact_trigger_tokens AS trigger, compact_target_tokens AS target FROM thread_metadata").get();
      db.close();
      return { thread_id, ...row };
    }),
    aliases,
  };
}

const PA_TURNS = [["KEEP-TURN prompt one", "KEEP-TURN answer one"], ["REMOVED-TURN prompt two", "REMOVED-TURN answer two"]];
const FILLER = " filler".repeat(400);
const SMALL_COMPACT = { trigger: 2000, target: 1000 };

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

function liveAuth() {
  if (process.env.CLAUDE_LHC_LIVE !== "1") return { skip: "needs real model turns; set CLAUDE_LHC_LIVE=1 (isolated HOME and CLAUDE_CONFIG_DIR, auth from env)" };
  const auth = LIVE_AUTH_VARS.find((v) => process.env[v]);
  if (!auth) return { skip: `no isolated auth: export one of ${LIVE_AUTH_VARS.join(", ")} for the run; live drives never use the real Claude login` };
  return { auth };
}

async function liveTurn(s, text, uuid) {
  const before = s.msgs().length;
  s.send(userFrame(text, uuid));
  await s.waitFor(() => s.msgs().slice(before).some((m) => m.type === "result"), `result for "${text}"`, 180_000);
  const turn = s.msgs().slice(before);
  const assistants = turn.filter((m) => m.type === "assistant" && m.parent_tool_use_id === null);
  return { result: turn.find((m) => m.type === "result"), lastAssistantUuid: assistants.at(-1)?.uuid };
}

async function liveRollback(evidenceDir, label, { compactAfterRollback }) {
  const scratch = new Scratch(label);
  scratch.home = join(scratch.dir, "home");
  mkdirSync(scratch.home, { recursive: true });
  const liveOptions = (extra) => baseOptions(scratch, { ...extra, env: { ...process.env, HOME: scratch.home, CLAUDE_CONFIG_DIR: scratch.claudeHome } });
  const sidecars = [];
  try {
    const gen1 = randomUUID();
    const first = new Sidecar(scratch, "turns", { live: true });
    sidecars.push(first);
    first.send({ type: "start", options: liveOptions({ sessionId: gen1 }) });
    await first.waitFor(() => first.logHas(`as generation ${gen1}`), "created-thread log line");
    const keptPromptUuid = randomUUID();
    const kept = await liveTurn(first, "Remember the secret word KEEP-ALPHA. Reply with just OK.", keptPromptUuid);
    const removed = await liveTurn(first, "Remember the second secret word REMOVED-BRAVO. Reply with just OK.");
    assert((await first.stop()) === 0, "turn sidecar did not exit 0");
    const nativeLines = (scratch.projected(gen1) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert(nativeLines.some((l) => l.type === "user" && l.uuid === keptPromptUuid), "the CLI did not write the prompt line under the host's prompt uuid, so a rollback walk cannot resolve through it");
    assert(kept.result?.subtype === "success" && removed.result?.subtype === "success", "a seed turn failed");
    assert(kept.lastAssistantUuid, "no assistant uuid on the kept turn");
    const after = new Sidecar(scratch, "after-rollback", { live: true });
    sidecars.push(after);
    after.send({ type: "start", options: liveOptions({ resume: gen1, resumeSessionAt: kept.lastAssistantUuid }) });
    await after.waitFor(() => after.logHas("resumed thread"), "resumed-thread log line");
    assert(after.logHas(`rollback to event`) && after.logHas(`via ${kept.lastAssistantUuid}`), "no rollback log line naming the kept message");
    const projected = scratch.projected(generationFrom(after)) ?? "";
    assert(projected.includes("KEEP-ALPHA") && !projected.includes("REMOVED-BRAVO"), "the rollback projection does not end at the kept turn");
    if (compactAfterRollback) {
      const before = after.msgs().length;
      after.send(userFrame("/compact"));
      await after.waitFor(() => after.msgs().slice(before).some((m) => m.type === "result"), "post-rollback compact result", 180_000);
      assert(after.msgs().slice(before).some((m) => m.type === "system" && m.subtype === "compact_boundary"), "no compact_boundary after the post-rollback /compact");
    }
    const ask = await liveTurn(after, "What was the second secret word I asked you to remember? If there was none, say NONE. Reply with the word only.");
    assert((await after.stop()) === 0, "rollback sidecar did not exit 0");
    const answer = String(ask.result?.result ?? "");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "answer.txt"), `${JSON.stringify(ask.result, null, 2)}\n`);
    assert(ask.result?.subtype === "success" && ask.result.is_error !== true, `the continued turn failed: ${JSON.stringify(ask.result?.errors ?? answer)}`);
    assert(!answer.includes("REMOVED-BRAVO"), `the continued answer knows the removed turn: ${answer}`);
    return `rolled back to ${kept.lastAssistantUuid.slice(0, 8)}${compactAfterRollback ? ", /compact" : ""}; answer "${answer.trim()}"`;
  } finally {
    for (const s of sidecars) if (s.exitCode === undefined) await s.stop();
    mkdirSync(evidenceDir, { recursive: true });
    for (const s of sidecars) s.saveEvidence(evidenceDir);
    writeFileSync(join(evidenceDir, "transcript.jsonl"), sidecars.flatMap((s) => s.frames.map((f) => JSON.stringify({ sidecar: s.label, ...f }))).join("\n") + "\n");
    scratch.cleanup();
  }
}

function scratchProcesses(scratch) {
  return readdirSync("/proc").filter((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    try { return readFileSync(`/proc/${pid}/environ`, "utf8").includes(scratch.dir); } catch { return false; }
  });
}

async function until(pred, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
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
      assert(lines >= 1, `projected file for gen3 ${gen3} is empty`);
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

  async "start-no-home"(evidenceDir) {
    const scratch = new Scratch("start-no-home");
    try {
      const s = new Sidecar(scratch, "start-no-home");
      s.send({ type: "start", options: baseOptions(scratch, { sessionId: randomUUID(), lhc: { compact: { trigger: 300000, target: 180000 } } }) });
      const code = await s.exited;
      s.saveEvidence(evidenceDir);
      const errors = s.frames.filter((f) => f.type === "error");
      assert(code === 1, `expected exit 1, got ${code}`);
      assert(errors.length === 1 && errors[0].message.startsWith("lhc.home "), `expected one error frame naming lhc.home, got ${JSON.stringify(errors)}`);
      assert(!existsSync(scratch.lhcHome), "a store directory was created without lhc.home");
      return `exit=1 errorFrames=1 "${errors[0].message}" store=absent`;
    } finally { scratch.cleanup(); }
  },

  async "compact-policy"(evidenceDir) {
    const scratch = new Scratch("compact-policy");
    try {
      const created = { trigger: 700000, target: 140000 };
      const { sid2, seed } = await seedCompacted(scratch, evidenceDir, { lhc: { home: scratch.lhcHome, compact: created } },
        (s, sid1) => s.logHas(`as generation ${sid1}`) && s.logHas("context window "));
      const window = /context window (\d+) for model/.exec(seed.stderr.join("\n"))?.[1];
      const s = new Sidecar(scratch, "compact-policy");
      s.send({ type: "start", options: baseOptions(scratch, { resume: sid2, lhc: { home: scratch.lhcHome, compact: { trigger: 300000, target: 100000 } } }) });
      await s.waitFor(() => s.logHas("resumed thread"), "resumed-thread log line");
      const code = await s.stop();
      s.saveEvidence(evidenceDir);
      assert(code === 0, `resume sidecar exited ${code}`);
      assert(s.logHas(`compact policy from thread: trigger ${created.trigger} target ${created.target}`), "no `compact policy from thread` line on resume with a different pair");
      assert(scratch.threads().length === 1, "store does not hold exactly one thread");
      const db = new DatabaseSync(join(scratch.lhcHome, "threads", scratch.threads()[0]), { readOnly: true });
      const row = db.prepare("SELECT thread_id, compact_trigger_tokens, compact_target_tokens FROM thread_metadata").get();
      db.close();
      writeFileSync(join(evidenceDir, "thread_metadata.txt"), `${JSON.stringify(row)}\n`);
      assert(row.compact_trigger_tokens === created.trigger && row.compact_target_tokens === created.target, `thread row holds ${JSON.stringify(row)}`);
      return `row trigger=${row.compact_trigger_tokens} target=${row.compact_target_tokens} after a resume that sent 300000/100000; window=${window} read with no model call`;
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

  async "thread-start"(evidenceDir) {
    const scratch = new Scratch("thread-start");
    try {
      const { gen1, threadId } = await seedCaptured(scratch, PA_TURNS);
      const started = await startAndStop(scratch, "fresh-start", { sessionId: randomUUID() }, evidenceDir);
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

  async rollback(evidenceDir) {
    const scratch = new Scratch("rollback");
    try {
      const { gen1, threadId, anchors } = await seedCaptured(scratch, PA_TURNS);
      const { s, gen } = await startAndStop(scratch, "rollback", { resume: gen1, resumeSessionAt: anchors[0] }, evidenceDir);
      const projected = scratch.projected(gen) ?? "";
      writeFileSync(join(evidenceDir, "projected.jsonl"), projected);
      assert(projected.includes("KEEP-TURN answer one"), "projected file lost the kept turn");
      assert(!projected.includes("REMOVED-TURN"), "projected file still carries the removed turn: the host rollback was ignored");
      assert(s.stderr.some((l) => /rollback to event \d+ via /.test(l) && l.endsWith(`via ${anchors[0]}`)), "no `rollback to event <n> via <anchor>` log line");
      assert(scratch.threads().length === 1, "rollback forked the store");
      return `resume:gen1 resumeSessionAt:keep-anchor -> thread ${threadId} gen=${gen.slice(0, 8)} projected keep=yes removed=no threads=1`;
    } finally { scratch.cleanup(); }
  },

  async "rollback-unknown-anchor"(evidenceDir) {
    const scratch = new Scratch("rollback-unknown-anchor");
    try {
      const { gen1, eventCount } = await seedCaptured(scratch, PA_TURNS);
      const events = await eventCount();
      const unknown = randomUUID();
      const s = new Sidecar(scratch, "rollback-unknown-anchor");
      s.send({ type: "start", options: baseOptions(scratch, { resume: gen1, resumeSessionAt: unknown }) });
      const code = await s.exited;
      s.saveEvidence(evidenceDir);
      const errors = s.frames.filter((f) => f.type === "error");
      assert(code === 1, `expected exit 1, got ${code}`);
      assert(errors.length === 1 && errors[0].message === `rollback anchor ${unknown} not found`, `expected one rollback anchor error frame, got ${JSON.stringify(errors)}`);
      assert(scratch.projectedFiles().length === 0, "a refused rollback still projected a file");
      const after = await eventCount();
      assert(after === events, `a refused rollback wrote ${after - events} event(s)`);
      return `resumeSessionAt:${unknown.slice(0, 8)} (in no transcript) -> exit=1 "${errors[0].message.slice(0, 16)}... not found", nothing projected, events ${events}->${after}`;
    } finally { scratch.cleanup(); }
  },

  async "rollback-restart"(evidenceDir) {
    const scratch = new Scratch("rollback-restart");
    try {
      const { gen1, anchors } = await seedCaptured(scratch, PA_TURNS);
      const rolled = await startAndStop(scratch, "rollback", { resume: gen1, resumeSessionAt: anchors[0] }, evidenceDir);
      const restarted = await startAndStop(scratch, "restart", { resume: rolled.gen }, evidenceDir);
      const viaOld = await startAndStop(scratch, "restart-old-alias", { resume: gen1 }, evidenceDir);
      const files = { rollback: scratch.projected(rolled.gen), restart: scratch.projected(restarted.gen), "restart-old-alias": scratch.projected(viaOld.gen) };
      for (const [label, text] of Object.entries(files)) {
        assert(text !== null, `no projected file after ${label}`);
        writeFileSync(join(evidenceDir, `${label}.projected.jsonl`), text);
        assert(text.includes("KEEP-TURN answer one"), `${label} projected file lost the kept turn`);
        assert(!text.includes("REMOVED-TURN"), `${label} projected file carries the removed turn`);
      }
      assert(!restarted.s.logHas("rollback to event"), "the plain restart rolled back again");
      assert(scratch.threads().length === 1, "restart after rollback forked the store");
      return `rollback gen=${rolled.gen.slice(0, 8)} -> restart gen=${restarted.gen.slice(0, 8)} and restart via gen1 both end at the anchor; threads=1`;
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
      assert(s.logHas(`via ${anchors[0]} (nearest captured ancestor of ${synthetic})`), "the synthetic anchor did not resolve to the kept assistant message");
      const { compacted } = await compactOnce(scratch, "compact", { resume: gen }, evidenceDir);
      const { gen: restarted } = await startAndStop(scratch, "restart", { resume: compacted }, evidenceDir);
      const files = { rollback: scratch.projected(gen) ?? "", compact: scratch.projected(compacted) ?? "", restart: scratch.projected(restarted) ?? "" };
      for (const [label, text] of Object.entries(files)) {
        writeFileSync(join(evidenceDir, `${label}.projected.jsonl`), text);
        assert(!text.includes("REMOVED-TURN"), `${label} projected file carries the removed turn`);
      }
      assert(files.rollback.includes("KEEP-TURN answer one"), "the rollback projection lost the kept turn");
      return "resumeSessionAt:<synthetic notice> -> kept through its nearest captured ancestor; removed text absent after start, /compact, restart";
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
      const small = { lhc: { home: scratch.lhcHome, compact: SMALL_COMPACT } };
      const seed = await compactOnce(scratch, "seed-compact", { ...small, resume: gen1 }, evidenceDir);
      const rolled = new Sidecar(scratch, "rollback-start");
      rolled.send({ type: "start", options: baseOptions(scratch, { resume: seed.compacted, resumeSessionAt: anchors[1] }) });
      await rolled.waitFor(() => rolled.logHas("resumed thread"), "rollback resumed-thread log line");
      const genAfterRollback = generationFrom(rolled);
      rolled.send(userFrame("/compact"));
      await rolled.waitFor(() => rolled.msgs().some((m) => m.type === "result"), "post-rollback compact result");
      const genAfterCompact = rolled.msgs().find((m) => m.type === "system" && m.subtype === "compact_boundary")?.session_id;
      assert((await rolled.stop()) === 0, "rollback sidecar did not exit 0");
      rolled.saveEvidence(evidenceDir);
      assert(rolled.logHas("[lhc compact:auto]"), "the rollback behind the compact point did not compact before projecting");
      assert(genAfterCompact, "no compact_boundary after the post-rollback /compact");
      const { gen: genAfterRestart } = await startAndStop(scratch, "restart", { resume: genAfterCompact }, evidenceDir);
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

  async "rollback-projected-anchor"(evidenceDir) {
    const scratch = new Scratch("rollback-projected-anchor");
    try {
      const { gen1 } = await seedCaptured(scratch, PA_TURNS);
      const { compacted } = await compactOnce(scratch, "compact", { resume: gen1 }, evidenceDir);
      const lines = (scratch.projected(compacted) ?? "").trim().split("\n").map((l) => JSON.parse(l));
      const anchor = lines.find((l) => JSON.stringify(l.message).includes("KEEP-TURN answer one"));
      assert(anchor?.lhcSource, "the compacted projection's KEEP line records no capture key");
      const { s, gen } = await startAndStop(scratch, "rollback", { resume: compacted, resumeSessionAt: anchor.uuid }, evidenceDir);
      const projected = scratch.projected(gen) ?? "";
      writeFileSync(join(evidenceDir, "projected.jsonl"), projected);
      assert(s.stderr.some((l) => /rollback to event \d+ via /.test(l) && l.endsWith(`via ${anchor.uuid}`)), "no `rollback to event <n> via <projected uuid>` log line");
      assert(projected.includes("KEEP-TURN answer one") && !projected.includes("REMOVED-TURN"), "the rollback to a projected line does not end at KEEP");
      return `resumeSessionAt:<projected KEEP line after /compact> -> resolved through ${anchor.lhcSource.slice(0, 30)}..., projected keep=yes removed=no`;
    } finally { scratch.cleanup(); }
  },

  async "window-shrink"(evidenceDir) {
    const scratch = new Scratch("window-shrink");
    try {
      const words = (i) => Array.from({ length: 5000 }, (_, j) => `w${(i * 7919 + j * 104729) % 99991}`).join(" ");
      const turns = Array.from({ length: 20 }, (_, i) => [`BIG-TURN prompt ${i} ${words(i)}`, `BIG-TURN answer ${i}`]);
      const { gen1 } = await seedCaptured(scratch, turns);
      const policy = { lhc: { home: scratch.lhcHome, compact: { trigger: 700000, target: 140000 } } };
      const wide = new Sidecar(scratch, "set-model");
      wide.send({ type: "start", options: baseOptions(scratch, { ...policy, resume: gen1, model: "claude-sonnet-5" }) });
      await wide.waitFor(() => wide.logHas("resumed thread") && wide.logHas("context window 1000000"), "1M resume and window read");
      assert(!wide.logHas("served context"), "the 1M resume already found the view past the trigger; the seed is too big for this drive");
      const res = await wide.control(1, "setModel", { model: "claude-sonnet-4-6" });
      assert(res.ok, `setModel failed: ${res.error}`);
      assert(wide.logHas("compact policy capped to window 200000: trigger 160000 target 80000"), "setModel to a 200k model did not cap the pair");
      const queued = wide.stderr.find((l) => /served context \d+ tokens is at or past the compact trigger 160000; compacting before the next prompt/.test(l));
      assert(queued, "setModel to a smaller window did not queue a compact before the next prompt");
      assert(!wide.logHas("[lhc compact"), "setModel compacted at once instead of before the next prompt");
      assert((await wide.stop()) === 0, "setModel sidecar did not exit 0");
      wide.saveEvidence(evidenceDir);
      const narrow = new Sidecar(scratch, "resume-narrow");
      narrow.send({ type: "start", options: baseOptions(scratch, { resume: gen1, model: "claude-sonnet-4-6" }) });
      await narrow.waitFor(() => narrow.logHas("resumed thread"), "200k resume log line");
      const order = ["served context", "[lhc compact:auto]", "resumed thread"].map((t) => narrow.stderr.findIndex((l) => l.includes(t)));
      const gens = narrow.stderr.filter((l) => /^\[claude-lhc\] generation \S+: \d+ projected lines/.test(l));
      assert((await narrow.stop()) === 0, "200k resume sidecar did not exit 0");
      narrow.saveEvidence(evidenceDir);
      assert(order[0] >= 0 && order[1] > order[0] && order[2] > order[1], `expected served context > compact > resumed in stderr, got indexes ${order.join(",")}`);
      assert(narrow.stderr[order[1]].includes("(target 80000)"), "the resume compact did not use the capped target");
      assert(gens.length === 2, `expected the oversized projection and the compacted one, got ${gens.length} generation line(s)`);
      return `setModel 1M->200k queued a compact (${/served context (\d+)/.exec(queued)[1]} tokens >= 160000); resume onto 200k compacted before start returned, target 80000`;
    } finally { scratch.cleanup(); }
  },

  async controls(evidenceDir) {
    const scratch = new Scratch("controls");
    const late = await startEchoMcp("late");
    const s = new Sidecar(scratch, "controls");
    try {
      const sid1 = randomUUID();
      s.send({ type: "start", options: baseOptions(scratch, { sessionId: sid1 }) });
      await s.waitFor(() => s.logHas(`as generation ${sid1}`), "created-thread log line");
      const set = await s.control(1, "setMcpServers", { servers: { late: late.config } });
      assert(set.ok && set.value.added.includes("late") && Object.keys(set.value.errors).length === 0, `setMcpServers: ${JSON.stringify(set)}`);
      const flag = await s.control(2, "applyFlagSettings", { settings: { model: FLAG_MODEL } });
      assert(flag.ok, `applyFlagSettings: ${flag.error}`);
      const sid2 = await compactNow(s);
      const status = await s.control(3, "mcpServerStatus", {});
      const usage = await s.control(4, "getContextUsage", { opts: { detail: "summary" } });
      const code = await s.stop();
      const server = lateServer(status);
      assert(sid2 !== sid1, "the compact did not start a new generation");
      assert(server?.status === "connected" && server.tools?.some((t) => t.name === "ping"), `the late server after the swap: ${JSON.stringify(server)}`);
      assert(usage.ok && usage.value.model === FLAG_MODEL, `the flag model after the swap: ${usage.ok ? usage.value.model : usage.error}`);
      assert(s.logHas(`generation ${sid2}: replayed setMcpServers, applyFlagSettings`), "no replay line for the new generation");
      assert(code === 0 && !s.error, `sidecar exited ${code} ${s.error ?? ""}`);
      return `generation ${sid1.slice(0, 8)} -> ${sid2.slice(0, 8)}; late server ${server.status} with ${server.tools.map((t) => t.name).join(",")}; flag model ${usage.value.model}`;
    } finally {
      if (s.exitCode === undefined) await s.stop();
      s.saveEvidence(evidenceDir);
      late.close();
      scratch.cleanup();
    }
  },

  async "controls-refused"(evidenceDir) {
    const scratch = new Scratch("controls-refused");
    const s = new Sidecar(scratch, "controls-refused");
    try {
      const sid = randomUUID();
      s.send({ type: "start", options: baseOptions(scratch, { sessionId: sid }) });
      await s.waitFor(() => s.logHas(`as generation ${sid}`), "created-thread log line");
      const sent = [...Object.entries(REFUSED_CONTROLS), ["forkSession", {}]];
      const answers = [];
      for (const [i, [method, params]] of sent.entries()) answers.push([method, await s.control(i + 1, method, params)]);
      const status = await s.control(sent.length + 1, "mcpServerStatus", {});
      const code = await s.stop();
      for (const [method, res] of answers) assert(!res.ok && res.error.includes(method), `${method} answered ${JSON.stringify(res)}`);
      assert(answers.filter(([, res]) => res.error.includes("refused")).length === 3, "the three refused methods did not say refused");
      assert(status.ok, `mcpServerStatus after the refusals: ${status.error}`);
      assert(!s.frames.some((f) => f.type === "error") && code === 0, `the session did not stay usable: exit ${code} ${s.error ?? ""}`);
      return answers.map(([method, res]) => `${method}: ${res.error}`).join("; ");
    } finally {
      if (s.exitCode === undefined) await s.stop();
      s.saveEvidence(evidenceDir);
      scratch.cleanup();
    }
  },

  async "set-compact-policy"(evidenceDir) {
    const scratch = new Scratch("set-compact-policy");
    const s = new Sidecar(scratch, "set-compact-policy");
    try {
      const sid = randomUUID();
      s.send({ type: "start", options: baseOptions(scratch, { sessionId: sid, model: "claude-sonnet-4-6" }) });
      await s.waitFor(() => s.logHas(`as generation ${sid}`) && s.logHas("context window "), "created-thread and window lines");
      const bad = await s.control(1, "setCompactPolicy", { policy: { trigger: 1000, target: 1000 } });
      const set = await s.control(2, "setCompactPolicy", { policy: { trigger: 700000, target: 140000 } });
      const code = await s.stop();
      assert(!bad.ok && bad.error.startsWith("setCompactPolicy params.policy must be"), `the bad pair answered ${JSON.stringify(bad)}`);
      assert(set.ok, `setCompactPolicy: ${set.error}`);
      assert(s.logHas("compact policy set on thread: trigger 700000 target 140000"), "no `compact policy set on thread` line");
      const capped = s.stderr.find((l) => l.includes("compact policy capped to window"));
      assert(capped?.endsWith("trigger 160000 target 80000"), `no cap to the 200k window: ${capped}`);
      assert(code === 0, `sidecar exited ${code}`);
      const db = new DatabaseSync(join(scratch.lhcHome, "threads", scratch.threads()[0]), { readOnly: true });
      const row = db.prepare("SELECT compact_trigger_tokens, compact_target_tokens FROM thread_metadata").get();
      db.close();
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "thread_metadata.txt"), `${JSON.stringify(row)}\n`);
      assert(row.compact_trigger_tokens === 700000 && row.compact_target_tokens === 140000, `thread row holds ${JSON.stringify(row)}`);
      return `row trigger=${row.compact_trigger_tokens} target=${row.compact_target_tokens}; live pair capped to 160000/80000; bad pair refused`;
    } finally {
      if (s.exitCode === undefined) await s.stop();
      s.saveEvidence(evidenceDir);
      scratch.cleanup();
    }
  },

  async "controls-live"(evidenceDir) {
    const gate = liveAuth();
    if (gate.skip) return gate;
    const scratch = new Scratch("controls-live");
    scratch.home = join(scratch.dir, "home");
    mkdirSync(scratch.home, { recursive: true });
    const late = await startEchoMcp("late");
    const s = new Sidecar(scratch, "controls-live", { live: true });
    try {
      const sid1 = randomUUID();
      s.send({ type: "start", options: baseOptions(scratch, { sessionId: sid1, env: { ...process.env, HOME: scratch.home, CLAUDE_CONFIG_DIR: scratch.claudeHome } }) });
      await s.waitFor(() => s.logHas(`as generation ${sid1}`), "created-thread log line");
      const warm = await liveTurn(s, "Reply with just OK.");
      const set = await s.control(1, "setMcpServers", { servers: { late: late.config } });
      assert(set.ok && Object.keys(set.value.errors).length === 0, `setMcpServers: ${JSON.stringify(set)}`);
      const sid2 = await compactNow(s);
      const before = s.msgs().length;
      const ask = await liveTurn(s, "Call the ping tool of the MCP server named late, then reply with exactly the text it returned.");
      const code = await s.stop();
      const turn = s.msgs().slice(before);
      const used = turn.flatMap((m) => (m.type === "assistant" ? m.message.content : [])).find((b) => b.type === "tool_use" && b.name === "mcp__late__ping");
      const output = turn.flatMap((m) => (m.type === "user" && Array.isArray(m.message?.content) ? m.message.content : [])).find((b) => b.type === "tool_result" && b.tool_use_id === used?.id);
      assert(warm.result?.subtype === "success", `the first turn failed: ${JSON.stringify(warm.result)}`);
      assert(ask.result?.subtype === "success" && ask.result.session_id === sid2, `the turn after /compact failed or ran outside ${sid2}: ${JSON.stringify(ask.result)}`);
      assert(used, "Claude did not call mcp__late__ping after the swap");
      assert(JSON.stringify(output?.content ?? "").includes("pong from late") && output.is_error !== true, `the tool call failed: ${JSON.stringify(output)}`);
      assert(code === 0, `sidecar exited ${code}`);
      return `mcp__late__ping answered "pong from late" in generation ${sid2.slice(0, 8)}; reply "${String(ask.result.result).trim()}"`;
    } finally {
      if (s.exitCode === undefined) await s.stop();
      s.saveEvidence(evidenceDir);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "transcript.jsonl"), s.frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
      late.close();
    }
  },

  async fork(evidenceDir) {
    const scratch = new Scratch("fork");
    try {
      const { gen1, threadId, anchors } = await seedCaptured(scratch, PA_TURNS);
      const policy = { lhc: { home: scratch.lhcHome, compact: { trigger: 700000, target: 140000 } } };
      await startAndStop(scratch, "seed-policy", { ...policy, resume: gen1 }, evidenceDir);
      const forked = await callInScratchEnv(scratch, "forkSession", [gen1, { lhc: { home: scratch.lhcHome }, dir: scratch.cwd, upToMessageId: anchors[0] }]);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "fork-result.json"), `${JSON.stringify(forked, null, 2)}\n`);
      assert(forked.code === 0, `forkSession failed: ${forked.error ?? forked.stderr}`);
      const { sessionId, headMessageId } = forked.value;
      const forkFile = scratch.projected(sessionId) ?? "";
      assert(headMessageId === JSON.parse(forkFile.trim().split("\n").filter((l) => JSON.parse(l).uuid).at(-1)).uuid, "headMessageId is not the fork file's last message");
      const fork = await startAndStop(scratch, "resume-fork", { resume: sessionId }, evidenceDir);
      const source = await startAndStop(scratch, "resume-source", { resume: gen1 }, evidenceDir);
      const files = { "projected-fork": scratch.projected(fork.gen) ?? "", "projected-source": scratch.projected(source.gen) ?? "" };
      for (const [label, text] of Object.entries(files)) writeFileSync(join(evidenceDir, `${label}.jsonl`), text);
      const rows = threadRows(scratch);
      writeFileSync(join(evidenceDir, "thread-rows.txt"), `${JSON.stringify(rows, null, 2)}\n`);
      for (const text of [forkFile, files["projected-fork"]]) {
        assert(text.includes("KEEP-TURN answer one"), "the fork lost the turn it was cut at");
        assert(!text.includes("REMOVED-TURN"), "the fork carries the turn after the fork point");
      }
      assert(files["projected-source"].includes("REMOVED-TURN answer two"), "the source lost a turn after the fork");
      const forkThread = threadIdFrom(fork.s);
      assert(forkThread && forkThread !== threadId, `resuming the fork did not open a separate thread (${forkThread})`);
      assert(fork.s.logHas("compact policy from thread: trigger 700000 target 140000"), "the fork did not carry the source's compact policy");
      assert(rows.threads.length === 2 && rows.threads.every((t) => t.trigger === 700000 && t.target === 140000), `thread rows: ${JSON.stringify(rows.threads)}`);
      const history = await callInScratchEnv(scratch, "getSessionMessages", [gen1, { lhc: { home: scratch.lhcHome }, dir: scratch.cwd }]);
      const projectedKeep = history.value?.find((m) => JSON.stringify(m.message).includes("KEEP-TURN answer one"))?.uuid;
      assert(projectedKeep && projectedKeep !== anchors[0], "the restarted source's history has no projected KEEP line");
      const again = await callInScratchEnv(scratch, "forkSession", [gen1, { lhc: { home: scratch.lhcHome }, dir: scratch.cwd, upToMessageId: projectedKeep }]);
      assert(again.code === 0, `forkSession at a history id failed: ${again.error ?? again.stderr}`);
      const againFile = scratch.projected(again.value.sessionId) ?? "";
      writeFileSync(join(evidenceDir, "projected-history-fork.jsonl"), againFile);
      assert(againFile.includes("KEEP-TURN answer one") && !againFile.includes("REMOVED-TURN"), "the fork at a history id does not end at KEEP");
      const head = await startAndStop(scratch, "resume-fork-at-head", { resume: sessionId, resumeSessionAt: headMessageId }, evidenceDir);
      assert(head.s.stderr.some((l) => l.includes(`via ${headMessageId}`)), "resumeSessionAt the fork's headMessageId did not resolve");
      await compactOnce(scratch, "compact-source", { resume: gen1 }, evidenceDir);
      const afterCompact = await callInScratchEnv(scratch, "forkSession", [gen1, { lhc: { home: scratch.lhcHome }, dir: scratch.cwd }]);
      assert(afterCompact.code === 0, `forkSession right after a /compact failed: ${afterCompact.error ?? afterCompact.stderr}`);
      return `fork at KEEP -> thread ${forkThread} ends at KEEP (fork file and resume), source ${threadId} keeps REMOVED, both rows 700000/140000; a fork at the projected history id ends at KEEP; resumeSessionAt headMessageId resolves; a fork right after /compact succeeds`;
    } finally { scratch.cleanup(); }
  },

  async history(evidenceDir) {
    const scratch = new Scratch("history");
    try {
      const { gen1 } = await seedCaptured(scratch, PA_TURNS);
      const { compacted } = await compactOnce(scratch, "compact", { resume: gen1 }, evidenceDir);
      const store = { lhc: { home: scratch.lhcHome }, dir: scratch.cwd };
      const viaFirst = await callInScratchEnv(scratch, "getSessionMessages", [gen1, store]);
      const viaCurrent = await callInScratchEnv(scratch, "getSessionMessages", [compacted, store]);
      const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const native = await import(join(DIST, "nativeSessionFile.js"));
      const subagents = join(native.nativeProjectDir({ cwd: scratch.cwd, env: { CLAUDE_CONFIG_DIR: scratch.claudeHome } }), compacted, "subagents");
      mkdirSync(subagents, { recursive: true });
      const first = randomUUID();
      const line = (uuid, parentUuid, type, text) => JSON.stringify({ parentUuid, isSidechain: true, agentId, type, uuid, sessionId: compacted, cwd: scratch.cwd, message: { role: type, content: [{ type: "text", text }] } });
      writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${line(first, null, "user", "AGENT-TASK")}\n${line(randomUUID(), first, "assistant", "AGENT-REPLY")}\n`);
      writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: "toolu_after_compact" }));
      const agent = await callInScratchEnv(scratch, "getSubagentMessages", [gen1, agentId, store]);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "history.json"), `${JSON.stringify({ gen1, compacted, viaFirst: viaFirst.value, agent: agent.value }, null, 2)}\n`);
      assert(viaFirst.code === 0 && viaCurrent.code === 0 && agent.code === 0, `library call failed: ${viaFirst.error ?? viaCurrent.error ?? agent.error}`);
      assert(scratch.projected(gen1) === null, "gen1 has a native file; the drive needs it to have none");
      assert(viaFirst.value.length > 0 && viaFirst.value.every((m) => m.session_id === compacted), "getSessionMessages(gen1) did not read the compacted generation");
      assert(JSON.stringify(viaFirst.value) === JSON.stringify(viaCurrent.value), "gen1 and the compacted id read different messages");
      assert(JSON.stringify(viaFirst.value).includes("REMOVED-TURN answer two"), "the current generation lost a turn");
      assert(agent.value.length === 2 && agent.value[0].parent_tool_use_id === "toolu_after_compact", `getSubagentMessages(gen1): ${JSON.stringify(agent.value)}`);
      return `getSessionMessages(gen1) reads compacted gen ${compacted.slice(0, 8)} (${viaFirst.value.length} messages; gen1 has no file); getSubagentMessages(gen1) finds an agent under the compacted gen`;
    } finally { scratch.cleanup(); }
  },

  async "fork-live"(evidenceDir) {
    const gate = liveAuth();
    if (gate.skip) return gate;
    const scratch = new Scratch("fork-live");
    scratch.home = join(scratch.dir, "home");
    mkdirSync(scratch.home, { recursive: true });
    const liveOptions = (extra) => baseOptions(scratch, { ...extra, env: { ...process.env, HOME: scratch.home, CLAUDE_CONFIG_DIR: scratch.claudeHome } });
    const sidecars = [];
    const ask = "What was the second secret word I asked you to remember? If there was none, say NONE. Reply with the word only.";
    try {
      const gen1 = randomUUID();
      const first = new Sidecar(scratch, "turns", { live: true });
      sidecars.push(first);
      first.send({ type: "start", options: liveOptions({ sessionId: gen1 }) });
      await first.waitFor(() => first.logHas(`as generation ${gen1}`), "created-thread log line");
      const kept = await liveTurn(first, "Remember the secret word KEEP-ALPHA. Reply with just OK.");
      const removed = await liveTurn(first, "Remember the second secret word REMOVED-BRAVO. Reply with just OK.");
      assert((await first.stop()) === 0, "turn sidecar did not exit 0");
      assert(kept.result?.subtype === "success" && removed.result?.subtype === "success" && kept.lastAssistantUuid, "a seed turn failed");
      const forked = await callInScratchEnv(scratch, "forkSession", [gen1, { lhc: { home: scratch.lhcHome }, dir: scratch.cwd, upToMessageId: kept.lastAssistantUuid }], { live: true });
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "fork-result.json"), `${JSON.stringify(forked, null, 2)}\n`);
      assert(forked.code === 0, `forkSession failed: ${forked.error ?? forked.stderr}`);
      const answers = {};
      for (const [label, resume] of [["fork", forked.value.sessionId], ["source", gen1]]) {
        const s = new Sidecar(scratch, `ask-${label}`, { live: true });
        sidecars.push(s);
        s.send({ type: "start", options: liveOptions({ resume }) });
        await s.waitFor(() => s.logHas("resumed thread"), `${label} resumed-thread log line`);
        const turn = await liveTurn(s, ask);
        assert((await s.stop()) === 0, `${label} sidecar did not exit 0`);
        assert(turn.result?.subtype === "success" && turn.result.is_error !== true, `the ${label} turn failed: ${JSON.stringify(turn.result?.errors ?? turn.result?.result)}`);
        answers[label] = String(turn.result.result ?? "");
      }
      writeFileSync(join(evidenceDir, "answers.json"), `${JSON.stringify(answers, null, 2)}\n`);
      assert(!answers.fork.includes("REMOVED-BRAVO"), `the fork knows the turn after the fork point: ${answers.fork}`);
      assert(answers.source.includes("REMOVED-BRAVO"), `the source lost the second word: ${answers.source}`);
      return `fork at the first turn answers "${answers.fork.trim()}"; source answers "${answers.source.trim()}"`;
    } finally {
      for (const s of sidecars) if (s.exitCode === undefined) await s.stop();
      mkdirSync(evidenceDir, { recursive: true });
      for (const s of sidecars) s.saveEvidence(evidenceDir);
      writeFileSync(join(evidenceDir, "transcript.jsonl"), sidecars.flatMap((s) => s.frames.map((f) => JSON.stringify({ sidecar: s.label, ...f }))).join("\n") + "\n");
      scratch.cleanup();
    }
  },

  async "subagent-live"(evidenceDir) {
    const gate = liveAuth();
    if (gate.skip) return gate;
    const scratch = new Scratch("subagent-live");
    scratch.home = join(scratch.dir, "home");
    mkdirSync(scratch.home, { recursive: true });
    const liveOptions = (extra) => baseOptions(scratch, { ...extra, env: { ...process.env, HOME: scratch.home, CLAUDE_CONFIG_DIR: scratch.claudeHome } });
    let s;
    try {
      const gen1 = randomUUID();
      s = new Sidecar(scratch, "subagent", { live: true });
      s.send({ type: "start", options: liveOptions({ sessionId: gen1 }) });
      await s.waitFor(() => s.logHas(`as generation ${gen1}`), "created-thread log line");
      const warm = await liveTurn(s, "Reply with just OK.");
      assert(warm.result?.subtype === "success", "the first turn failed");
      const before = s.msgs().length;
      s.send(userFrame("/compact"));
      await s.waitFor(() => s.msgs().slice(before).some((m) => m.type === "result"), "compact result", 180_000);
      const compacted = s.msgs().slice(before).find((m) => m.type === "system" && m.subtype === "compact_boundary")?.session_id;
      assert(compacted, "no compact_boundary after /compact");
      const launched = await liveTurn(s, "Use your Agent tool (also called Task) to launch one general-purpose subagent whose whole job is to reply with the word SUBAGENT-PONG. When it returns, reply with just DONE.");
      assert((await s.stop()) === 0, "sidecar did not exit 0");
      assert(launched.result?.subtype === "success", `the subagent turn failed: ${JSON.stringify(launched.result?.result)}`);
      const agentFile = scratch.projectedFiles().find((f) => f.includes(`${compacted}/subagents/`) && /agent-[^/]+\.jsonl$/.test(f));
      assert(agentFile, `no subagent transcript under the compacted generation ${compacted}`);
      const agentId = /agent-([^/]+)\.jsonl$/.exec(agentFile)[1];
      const messages = await callInScratchEnv(scratch, "getSubagentMessages", [gen1, agentId, { lhc: { home: scratch.lhcHome }, dir: scratch.cwd }], { live: true });
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "subagent-messages.json"), `${JSON.stringify({ gen1, compacted, agentId, ...messages }, null, 2)}\n`);
      assert(messages.code === 0, `getSubagentMessages failed: ${messages.error ?? messages.stderr}`);
      assert(messages.value.length > 0, "getSubagentMessages with the first session id returned nothing");
      const launchIds = s.msgs().flatMap((m) => (m.type === "assistant" ? m.message.content : [])).filter((b) => b.type === "tool_use").map((b) => b.id);
      assert(launchIds.includes(messages.value[0].parent_tool_use_id), `parent_tool_use_id ${messages.value[0].parent_tool_use_id} is not a tool call from the stream`);
      return `agent ${agentId} launched in compacted gen ${compacted.slice(0, 8)}; getSubagentMessages(gen1) returned ${messages.value.length} messages, launch ${messages.value[0].parent_tool_use_id}`;
    } finally {
      if (s && s.exitCode === undefined) await s.stop();
      if (s) s.saveEvidence(evidenceDir);
      scratch.cleanup();
    }
  },

  async "rollback-live"(evidenceDir) {
    const gate = liveAuth();
    return gate.skip ? gate : liveRollback(evidenceDir, "rollback-live", { compactAfterRollback: false });
  },

  async "rollback-live-compact"(evidenceDir) {
    const gate = liveAuth();
    return gate.skip ? gate : liveRollback(evidenceDir, "rollback-live-compact", { compactAfterRollback: true });
  },

  async client(evidenceDir) {
    const scratch = new Scratch("client");
    const stderr = [];
    const { query } = await import(join(DIST, "index.js"));
    const silent = { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } };
    let q;
    try {
      const sid = randomUUID();
      const options = baseOptions(scratch, { sessionId: sid, model: "claude-sonnet-4-6" });
      const t0 = Date.now();
      process.env.CLAUDE_LHC_NO_INFERENCE = "1";
      process.env.VERIFY_CLAUDE_LHC_SCRATCH = scratch.dir;
      q = query({ prompt: silent, options: { ...options, stderr: (d) => stderr.push(d) } });
      await until(() => stderr.join("").includes(`as generation ${sid}`), "created-thread log line from the default sidecar");
      const readyMs = Date.now() - t0;
      const usage = await q.getContextUsage();
      assert(typeof usage?.rawMaxTokens === "number", `getContextUsage answered ${JSON.stringify(usage)}`);
      const refused = await q.rewindFiles("x").then(() => "resolved", (e) => e.message);
      assert(refused.startsWith("rewindFiles is refused"), `rewindFiles answered ${refused}`);
      await q.setCompactPolicy({ trigger: 700000, target: 140000 });
      assert(stderr.join("").includes("compact policy set on thread: trigger 700000 target 140000"), "no `compact policy set on thread` line");
      const sidecars = scratchProcesses(scratch).filter((pid) => readFileSync(`/proc/${pid}/environ`, "utf8").includes(`VERIFY_CLAUDE_LHC_SCRATCH=${scratch.dir}`));
      assert(sidecars.length > 0, "no process inherited the host's environment before close: the sidecar did not inherit it");
      q.close();
      const end = await Promise.race([q.next(), new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
      assert(end !== "timeout" && end.done, `the stream did not end after close(): ${JSON.stringify(end)}`);
      await until(() => scratchProcesses(scratch).length === 0, "the sidecar and its claude to exit after close()", 15_000);
      const db = new DatabaseSync(join(scratch.lhcHome, "threads", scratch.threads()[0]), { readOnly: true });
      const row = db.prepare("SELECT compact_trigger_tokens, compact_target_tokens FROM thread_metadata").get();
      db.close();
      assert(scratch.threads().length === 1, `expected 1 thread file, got ${scratch.threads().length}`);
      assert(row.compact_trigger_tokens === 700000 && row.compact_target_tokens === 140000, `thread row holds ${JSON.stringify(row)}`);
      return `query() to created-thread ${readyMs}ms; getContextUsage window ${usage.rawMaxTokens}; rewindFiles refused; setCompactPolicy stored 700000/140000; close() ended the stream and every scratch process`;
    } finally {
      q?.close();
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "client.stderr.log"), stderr.join(""));
      scratch.cleanup();
    }
  },

  async consumer(evidenceDir) {
    const gate = liveAuth();
    if (gate.skip) return gate;
    const scratch = new Scratch("consumer");
    const home = join(scratch.dir, "home");
    mkdirSync(home, { recursive: true });
    const realKeyPrefix = scratch.dir.replace(/[^a-zA-Z0-9]/g, "-");
    const realProjects = join(homedir(), ".claude", "projects");
    try {
      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: scratch.claudeHome, DISABLE_AUTOUPDATER: "1" };
      delete env.CLAUDE_LHC_NO_INFERENCE;
      const child = spawn(process.execPath, ["--import", "tsx", "examples/consumer.ts", join(scratch.dir, "work")], { cwd: join(REPO, "packages/claude-lhc"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      const code = await new Promise((r) => {
        const timer = setTimeout(() => { process.kill(-child.pid, "SIGKILL"); r("timeout"); }, 15 * 60_000);
        child.on("exit", (c) => { clearTimeout(timer); r(c); });
      });
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "consumer.stdout.log"), stdout);
      writeFileSync(join(evidenceDir, "consumer.stderr.log"), stderr);
      const leaked = existsSync(realProjects) ? readdirSync(realProjects).filter((d) => d.startsWith(realKeyPrefix)) : [];
      assert(leaked.length === 0, `ISOLATION BREACH: ${leaked.join(", ")} written under ${realProjects}`);
      assert(code === 0 && stdout.includes("CONSUMER: PASS"), `consumer exit=${code}: ${stdout.trim().split("\n").at(-2) ?? "(no stdout)"}`);
      return `CONSUMER: PASS auth=${gate.auth}; ${stdout.split("\n").filter((l) => / ok /.test(l)).length} steps ok`;
    } finally { scratch.cleanup(); }
  },

  async turn(evidenceDir) {
    if (process.env.CLAUDE_LHC_LIVE !== "1") {
      return { skip: "needs a real model turn; set CLAUDE_LHC_LIVE=1 to run packages/claude-lhc/scripts/standalone.ts under a throwaway HOME/CLAUDE_CONFIG_DIR" };
    }
    const auth = LIVE_AUTH_VARS.find((v) => process.env[v]);
    if (!auth) {
      return { skip: `no isolated auth: export one of ${LIVE_AUTH_VARS.join(", ")} for the run; the live turn never uses the real Claude login` };
    }
    const scratch = new Scratch("live");
    const home = join(scratch.dir, "home");
    mkdirSync(home, { recursive: true });
    const realKeyPrefix = scratch.dir.replace(/[^a-zA-Z0-9]/g, "-");
    const realProjects = join(homedir(), ".claude", "projects");
    try {
      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: scratch.claudeHome, CLAUDE_LHC_HOME: scratch.lhcHome, TMPDIR: scratch.cwd, DISABLE_AUTOUPDATER: "1" };
      delete env.CLAUDE_LHC_NO_INFERENCE;
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/standalone.ts"], { cwd: join(REPO, "packages/claude-lhc"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      const code = await new Promise((r) => {
        const timer = setTimeout(() => { process.kill(-child.pid, "SIGKILL"); r("timeout"); }, 15 * 60_000);
        child.on("exit", (c) => { clearTimeout(timer); r(c); });
      });
      // standalone exits on failure without stopping its sidecar; reap the group so no claude child writes into scratch after cleanup.
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "standalone.stdout.log"), stdout);
      writeFileSync(join(evidenceDir, "standalone.stderr.log"), stderr);
      const leaked = existsSync(realProjects) ? readdirSync(realProjects).filter((d) => d.startsWith(realKeyPrefix)) : [];
      assert(leaked.length === 0, `ISOLATION BREACH: ${leaked.join(", ")} written under ${realProjects}`);
      assert(code === 0 && stdout.includes("RESULT: PASS"), `standalone exit=${code}: ${stdout.trim().split("\n").at(-1) ?? "(no stdout)"}`);
      const projected = scratch.projectedFiles();
      assert(projected.length > 0, "no native session files under the throwaway CLAUDE_CONFIG_DIR");
      return `standalone RESULT: PASS auth=${auth} nativeFiles=${projected.length} under throwaway CLAUDE_CONFIG_DIR; real ~/.claude/projects untouched for this cwd`;
    } finally { scratch.cleanup(); }
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
      ? ["start", "start-no-home", "compact", "compact-policy", "restart", "resume-superseded-alias", "resume-unknown", "resume-empty", "thread-start", "rollback", "rollback-unknown-anchor", "rollback-restart", "rollback-synthetic-anchor", "rollback-compact", "rollback-projected-anchor", "window-shrink", "controls", "controls-refused", "set-compact-policy", "fork", "history", "client", "turn", "rollback-live", "rollback-live-compact", "controls-live", "fork-live", "subagent-live", "consumer"]
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
