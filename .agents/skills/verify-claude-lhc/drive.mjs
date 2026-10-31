#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
  constructor(scratch, label, { live = false, inference = live } = {}) {
    this.label = label;
    this.frames = [];
    this.stderr = [];
    this.error = null;
    this.waiters = [];
    const env = { ...process.env, CLAUDE_CONFIG_DIR: scratch.claudeHome, CLAUDE_LHC_NO_INFERENCE: "1" };
    if (inference) delete env.CLAUDE_LHC_NO_INFERENCE;
    if (live) env.HOME = scratch.home;
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
  const compactUuid = randomUUID();
  s.send(userFrame("/compact", compactUuid));
  await s.waitFor(() => s.msgs().some((m) => m.type === "result"), "compact result frame");
  const boundary = s.msgs().find((m) => m.type === "system" && m.subtype === "compact_boundary");
  assert(boundary, "no compact_boundary after /compact");
  const sid2 = boundary.session_id;
  const code = await s.stop();
  s.saveEvidence(evidenceDir);
  assert(code === 0, `seed sidecar exited ${code}`);
  return { sid1, sid2, seed: s, compactUuid };
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

async function callInScratchEnv(scratch, fn, args, { live = false, entry = "index.js", childEnvAsOpEnv = false } = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: scratch.claudeHome, CLAUDE_LHC_NO_INFERENCE: "1" };
  if (live) {
    delete env.CLAUDE_LHC_NO_INFERENCE;
    env.HOME = scratch.home;
  }
  const url = JSON.stringify(pathToFileURL(join(DIST, entry)).href);
  const call = childEnvAsOpEnv ? `const args = ${JSON.stringify(args)}; args.at(-1).env = { ...process.env };` : `const args = ${JSON.stringify(args)};`;
  const script = `const lib = await import(${url}); ${call} process.stdout.write(JSON.stringify(await lib[${JSON.stringify(fn)}](...args)));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: scratch.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  scratch.groups.push(child.pid);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((r) => child.on("exit", r));
  return { code, stderr, value: code === 0 ? JSON.parse(stdout) : undefined, error: /Error: (.+)/.exec(stderr)?.[1] };
}

function countedSidecar(scratch) {
  const log = join(scratch.dir, "sidecar-starts.log");
  const hook = join(scratch.dir, "count-start.mjs");
  writeFileSync(hook, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, process.pid + "\\n");\n`);
  return { spawn: { command: process.execPath, args: ["--import", pathToFileURL(hook).href, ENTRY] }, starts: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0) };
}

async function inspectThroughClient(scratch, ids, home = scratch.lhcHome, options = {}) {
  const counted = countedSidecar(scratch);
  const res = await callInScratchEnv(scratch, "inspectSessions", [ids, { lhc: { home, spawn: counted.spawn } }], { ...options, entry: "client/index.js" });
  const starts = counted.starts();
  rmSync(join(scratch.dir, "sidecar-starts.log"), { force: true });
  return { ...res, starts };
}

async function writeStockSession(scratch, sessionId, prompt) {
  const native = await import(join(DIST, "nativeSessionFile.js"));
  const path = native.nativeSessionPath({ sessionId, cwd: scratch.cwd, env: { CLAUDE_CONFIG_DIR: scratch.claudeHome } });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", uuid: randomUUID(), sessionId, cwd: scratch.cwd, message: { role: "user", content: prompt } })}\n`);
  return path;
}

async function writeSubagentFixture(scratch, sessionId, toolUseId) {
  const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const native = await import(join(DIST, "nativeSessionFile.js"));
  const subagents = join(native.nativeProjectDir({ cwd: scratch.cwd, env: { CLAUDE_CONFIG_DIR: scratch.claudeHome } }), sessionId, "subagents");
  mkdirSync(subagents, { recursive: true });
  const first = randomUUID();
  const line = (uuid, parentUuid, type, text) => JSON.stringify({ parentUuid, isSidechain: true, agentId, type, uuid, sessionId, cwd: scratch.cwd, message: { role: type, content: [{ type: "text", text }] } });
  writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${line(first, null, "user", "AGENT-TASK")}\n${line(randomUUID(), first, "assistant", "AGENT-REPLY")}\n`);
  writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId }));
  return agentId;
}

const CLIENT_OPS_SCRIPT = `
const [clientEntry, rootEntry, gen1, compacted, agentId, anchor, home, cwd, claudeHome] = process.argv.slice(1);
const client = await import(clientEntry);
const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };
const store = { lhc: { home }, dir: cwd, env };
const timed = async (call) => { const t0 = performance.now(); const value = await call(); return { value, ms: Math.round(performance.now() - t0) }; };
const fork = await timed(() => client.forkSession(gen1, { ...store, upToMessageId: anchor }));
const forkMessages = await client.getSessionMessages(fork.value.sessionId, store);
const viaFirst = await client.getSessionMessages(gen1, store);
const agent = await client.getSubagentMessages(gen1, agentId, store);
const unknown = crypto.randomUUID();
const refused = await client.forkSession(unknown, store).then(() => null, (e) => e.message);
process.env.CLAUDE_CONFIG_DIR = claudeHome;
const root = await import(rootEntry);
const inProcess = await timed(() => root.forkSession(gen1, { ...store, upToMessageId: anchor }));
process.stdout.write(JSON.stringify({ entry: import.meta.resolve(clientEntry), fork, forkMessages, viaFirst, agent, unknown, refused, inProcessForkMs: inProcess.ms }));
`;

function hostEnvThatExposesLeaks(hostHome) {
  const env = { ...process.env, HOME: hostHome, CLAUDE_LHC_NO_INFERENCE: "1" };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

async function runClientOps(scratch, hostHome, args) {
  const env = hostEnvThatExposesLeaks(hostHome);
  const entries = [join(DIST, "client/index.js"), join(DIST, "index.js")].map((p) => pathToFileURL(p).href);
  const child = spawn(process.execPath, ["--input-type=module", "-e", CLIENT_OPS_SCRIPT, ...entries, ...args], { cwd: scratch.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  scratch.groups.push(child.pid);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((r) => child.on("exit", r));
  return { code, stderr, value: code === 0 ? JSON.parse(stdout) : undefined };
}

const FORBIDDEN_CLIENT_MODULE = /\/node_modules\/(?:lhc|effect|js-tiktoken|@anthropic-ai\/claude-agent-sdk)\//;

async function bundleInstalledClient(project, evidenceDir) {
  const { build } = await import(createRequire(join(REPO, "packages/claude-lhc/package.json")).resolve("esbuild"));
  writeFileSync(join(project, "client-entry.mjs"), `export * from "claude-lhc/client";\n`);
  const result = await build({ entryPoints: ["client-entry.mjs"], absWorkingDir: project, bundle: true, platform: "node", format: "esm", write: false, metafile: true, logLevel: "silent" });
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "installed-client-meta.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);
  return Object.keys(result.metafile.inputs).map((input) => resolve(project, input)).filter((path) => FORBIDDEN_CLIENT_MODULE.test(path));
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
const bigWords = (i) => Array.from({ length: 5000 }, (_, j) => `w${(i * 7919 + j * 104729) % 99991}`).join(" ");

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

const lifecycleAt = (msgs, uuid, state) => msgs.findIndex((m) => m.type === "command_lifecycle" && m.command_uuid === uuid && (state === undefined || m.state === state));
const resultsIn = (msgs) => msgs.flatMap((m, i) => (m.type === "result" ? [i] : []));
const compactSequence = (msgs, uuid) => msgs.map((m) =>
  m.type === "command_lifecycle" ? (m.command_uuid === uuid ? `lifecycle:${m.state}` : null)
  : m.type === "system" && m.subtype === "status" ? `status:${m.status ?? "null"}${m.compact_result ? ":" + m.compact_result : ""}`
  : m.type === "system" && m.subtype === "compact_boundary" ? "boundary"
  : m.type === "result" ? "result" : null).filter(Boolean);
const settlesCompact = (result, uuid) => result?.local_command === "compact" && result.user_message_uuid === uuid && JSON.stringify(result.user_message_uuids) === JSON.stringify([uuid]);
const boundaryAt = (msgs, trigger, from = 0) => msgs.findIndex((m, i) => i >= from && m.type === "system" && m.subtype === "compact_boundary" && m.compact_metadata?.trigger === trigger);
// The CLI's own prompt is about 37000 tokens. Reading filler.txt (about 20000 tokens) carries the next request past
// 45000, while a view rebuilt to 500 tokens lands back under it.
const FILLER_POLICY = { trigger: 45000, target: 500 };
const FILLER_FILE = Array.from({ length: 1000 }, (_, i) => `line ${i}: harbor lantern meadow orchard quarry ridge saddle timber valley willow anchor`).join("\n");
const AFTER_READ = "Use the Read tool to read filler.txt. Only after you have its contents, use the Bash tool to run `sleep 4; echo <the word that follows \"line 999:\">`";
const PENDING_TURN = `${AFTER_READ}. Then reply with just DONE.`;
const HELD_TURN = `${AFTER_READ}. Then use the Bash tool to run \`echo third\`. Then reply with just DONE.`;

// The diagnosis's procedure (proof/prototypes/p-cache-diagnosis/run.mjs in lhc-claude-driver): a thread grown by
// one pasted fixture, then resumed with one short prompt per sidecar, every /v1/messages body saved by a proxy.
const CACHE_LINE = "maple river stone cloud field\n";
const CACHE_GROWTH = (lines) =>
  `The following is pasted reference context. Retain it as context only. Do not summarize, analyze, or use tools. Reply only OK.\n<reference>\n${CACHE_LINE.repeat(lines)}</reference>\nReply only OK.`;
const CACHE_RESUME = "Reply only OK.";
const cacheFraction = (u = {}) => {
  const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return total === 0 ? null : (u.cache_read_input_tokens ?? 0) / total;
};
const messageText = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((b) => b.text ?? "").join(""));
const environmentReminderAt = (body) =>
  body.messages.findIndex((m) => m.role === "system" && messageText(m).startsWith("<system-reminder>") && messageText(m).includes("# Environment"));

async function captureProxy(evidenceDir) {
  const upstream = new URL(process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com");
  const secrets = Object.entries(process.env).filter(([k, v]) => /TOKEN|KEY|SECRET|PASSWORD/.test(k) && v.length > 5).map(([, v]) => v);
  mkdirSync(join(evidenceDir, "requests"), { recursive: true });
  const proxy = { label: "startup", requests: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url.startsWith("/v1/messages")) {
      const text = body.toString();
      const file = `requests/${String(proxy.requests.length + 1).padStart(3, "0")}-${proxy.label}.json`;
      if (secrets.some((secret) => text.includes(secret))) proxy.requests.push({ label: proxy.label, path: req.url, refused: "body holds a credential value" });
      else {
        writeFileSync(join(evidenceDir, file), text);
        proxy.requests.push({ label: proxy.label, path: req.url, file });
      }
    }
    const incoming = new URL(req.url, "http://localhost");
    const target = new URL(upstream);
    target.pathname = upstream.pathname.replace(/\/$/, "") + incoming.pathname;
    target.search = incoming.search;
    const headers = { ...req.headers, host: upstream.host, "content-length": body.length };
    delete headers.connection;
    delete headers["transfer-encoding"];
    const forward = (upstream.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    forward.on("error", () => { res.writeHead(502); res.end(); });
    forward.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  proxy.url = `http://127.0.0.1:${server.address().port}`;
  proxy.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  proxy.body = (label) => {
    const bodies = proxy.requests.filter((q) => q.label === label && q.file).map((q) => JSON.parse(readFileSync(join(evidenceDir, q.file), "utf8")));
    return bodies.filter((b) => Array.isArray(b.messages)).sort((a, b) => b.messages.length - a.messages.length)[0];
  };
  return proxy;
}

const cacheOptions = (scratch, proxy, extra) => ({
  cwd: scratch.cwd,
  model: process.env.MODEL ?? "claude-sonnet-5",
  pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? "claude",
  settingSources: [],
  tools: [],
  thinking: { type: "disabled" },
  includePartialMessages: true,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  env: { ...process.env, HOME: scratch.home, CLAUDE_CONFIG_DIR: scratch.claudeHome, ANTHROPIC_BASE_URL: proxy.url, DISABLE_AUTOUPDATER: "1" },
  ...extra,
});

function cacheRow(label, t0, firstToken, result, extra = {}) {
  return {
    label,
    ...extra,
    query_to_first_token_ms: firstToken === undefined ? null : Math.round(firstToken - t0),
    result_wall_ms: Math.round(performance.now() - t0),
    subtype: result?.subtype,
    is_error: result?.is_error,
    usage: result?.usage,
    total_input_tokens: (result?.usage?.input_tokens ?? 0) + (result?.usage?.cache_creation_input_tokens ?? 0) + (result?.usage?.cache_read_input_tokens ?? 0),
    cache_fraction: cacheFraction(result?.usage),
  };
}

async function stockCacheTurn(sdk, scratch, proxy, label, prompt, start) {
  proxy.label = label;
  const t0 = performance.now();
  let firstToken;
  const q = sdk.query({
    prompt: (async function* () { yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null }; await new Promise(() => {}); })(),
    options: cacheOptions(scratch, proxy, start),
  });
  try {
    for await (const m of q) {
      if (firstToken === undefined && m.type === "stream_event" && m.event?.delta?.type === "text_delta" && m.event.delta.text) firstToken = performance.now();
      if (m.type === "result") return { row: cacheRow(label, t0, firstToken, m), sessionId: m.session_id };
    }
    throw new Error(`${label}: stream ended with no result`);
  } finally { q.close(); }
}

async function lhcCacheTurn(scratch, proxy, sidecars, label, prompts, start) {
  proxy.label = label;
  const t0 = performance.now();
  const s = new Sidecar(scratch, label, { live: true, inference: false });
  sidecars.push(s);
  s.send({ type: "start", options: cacheOptions(scratch, proxy, { ...start, lhc: { home: scratch.lhcHome, compact: { trigger: 700000, target: 140000 } } }) });
  await s.waitFor(() => s.logHas("created thread") || s.logHas("resumed thread"), `${label} start log line`, 120_000);
  const started = performance.now();
  const rows = [];
  for (const [i, prompt] of prompts.entries()) {
    proxy.label = i === 0 ? label : `${label}-${i}`;
    const before = s.msgs().length;
    const turnStart = i === 0 ? t0 : performance.now();
    s.send(userFrame(prompt));
    let firstToken;
    await s.waitFor(() => {
      const turn = s.msgs().slice(before);
      if (firstToken === undefined && turn.some((m) => m.type === "stream_event" && m.event?.delta?.type === "text_delta" && m.event.delta.text)) firstToken = performance.now();
      return turn.some((m) => m.type === "result");
    }, `${proxy.label} result`, 600_000);
    const result = s.msgs().slice(before).find((m) => m.type === "result");
    const store = join(scratch.lhcHome, "attachments", `${threadIdFrom(s)}.jsonl`);
    rows.push(cacheRow(proxy.label, turnStart, firstToken, result, {
      ...(i === 0 && start.resume ? { query_to_resumed_ms: Math.round(started - t0) } : {}),
      session_id: result?.session_id,
      attachment_store_bytes: existsSync(store) ? statSync(store).size : 0,
    }));
  }
  assert((await s.stop()) === 0, `${label} sidecar did not exit 0`);
  rows[0].harvests = s.stderr.filter((l) => l.includes("attachments: "));
  return rows;
}

async function livePromptOrder(evidenceDir, label, compact, act) {
  const scratch = new Scratch(label);
  scratch.home = join(scratch.dir, "home");
  mkdirSync(scratch.home, { recursive: true });
  const s = new Sidecar(scratch, label, { live: true });
  try {
    const sid = randomUUID();
    s.send({ type: "start", options: baseOptions(scratch, { sessionId: sid, lhc: { home: scratch.lhcHome, compact }, env: { ...process.env, HOME: scratch.home, CLAUDE_CONFIG_DIR: scratch.claudeHome } }) });
    await s.waitFor(() => s.logHas(`as generation ${sid}`), "created-thread log line");
    writeFileSync(join(scratch.cwd, "filler.txt"), `${FILLER_FILE}\n`);
    const detail = await act(s);
    assert(s.exitCode === 0 && s.error === null, `sidecar exited ${s.exitCode} with error ${s.error}`);
    return detail;
  } finally {
    if (s.exitCode === undefined) await s.stop();
    s.saveEvidence(evidenceDir);
    scratch.cleanup();
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
      const { sid1, sid2, seed, compactUuid } = await seedCompacted(scratch, evidenceDir);
      assert(sid2 !== sid1, "compact did not mint a new session id");
      const seq = compactSequence(seed.msgs(), compactUuid);
      assert(JSON.stringify(seq) === JSON.stringify(["lifecycle:queued", "lifecycle:started", "status:compacting", "status:null:success", "boundary", "result", "lifecycle:completed"]),
        `compact frame order ${JSON.stringify(seq)}`);
      const result = seed.msgs().find((m) => m.type === "result");
      assert(settlesCompact(result, compactUuid) && result.is_error === false && result.result === "", `compact result ${JSON.stringify(result)}`);
      assert(result.session_id === sid2, "the compact result is not on the new generation");
      assert(scratch.projectedFiles().some((f) => f.includes(sid2)), `no projected file for ${sid2}`);
      assert(scratch.threads().length === 1, "store does not hold exactly one thread");

      const failing = new Sidecar(scratch, "failed-rebuild");
      const failedUuid = randomUUID();
      failing.send({ type: "start", options: baseOptions(scratch, { resume: sid2, lhc: { home: scratch.lhcHome, forceRebuildFailure: true } }) });
      await failing.waitFor(() => failing.logHas("resumed thread"), "resumed-thread log line");
      failing.send(userFrame("/compact", failedUuid));
      await failing.waitFor(() => lifecycleAt(failing.msgs(), failedUuid, "completed") > -1, "the failed compact's completed lifecycle");
      const failedCode = await failing.stop();
      failing.saveEvidence(evidenceDir);
      assert(failedCode === 0, `failed-rebuild sidecar exited ${failedCode}`);
      const failedSeq = compactSequence(failing.msgs(), failedUuid);
      assert(JSON.stringify(failedSeq) === JSON.stringify(["lifecycle:queued", "lifecycle:started", "status:compacting", "status:null:failed", "result", "lifecycle:completed"]),
        `failed compact frame order ${JSON.stringify(failedSeq)}`);
      const failed = failing.msgs().find((m) => m.type === "result");
      assert(settlesCompact(failed, failedUuid) && failed.is_error === false && String(failed.result).startsWith("Error during compaction: "), `failed compact result ${JSON.stringify(failed)}`);
      return `order=${seq.join(">")} gen1=${sid1.slice(0, 8)} gen2=${sid2.slice(0, 8)} result carries the /compact uuid and local_command=compact; failed rebuild order=${failedSeq.join(">")} result "${String(failed.result).slice(0, 60)}"; projected=yes threads=1 (empty view; proves boundary/projection plumbing, not summarization)`;
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
      const turns = Array.from({ length: 20 }, (_, i) => [`BIG-TURN prompt ${i} ${bigWords(i)}`, `BIG-TURN answer ${i}`]);
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

  async "compact-above-base"(evidenceDir) {
    const scratch = new Scratch("compact-above-base");
    const usageOf = async (s, id) => {
      const res = await s.control(id, "getContextUsage", { opts: { detail: "summary" } });
      assert(res.ok && Number.isSafeInteger(res.value.totalTokens), `getContextUsage answered ${JSON.stringify(res)}`);
      return res.value.totalTokens;
    };
    try {
      const fresh = new Sidecar(scratch, "base-prompt");
      const sid = randomUUID();
      fresh.send({ type: "start", options: baseOptions(scratch, { sessionId: sid }) });
      await fresh.waitFor(() => fresh.logHas(`as generation ${sid}`), "created-thread log line");
      const base = await usageOf(fresh, 1);
      assert((await fresh.stop()) === 0, "base-prompt sidecar did not exit 0");
      fresh.saveEvidence(evidenceDir);
      const policy = { trigger: base + 40000, target: 20000 };
      const { gen1 } = await seedCaptured(scratch, Array.from({ length: 8 }, (_, i) => [`BIG-TURN prompt ${i} ${bigWords(i)}`, `BIG-TURN answer ${i}`]));
      const first = new Sidecar(scratch, "resume-compact");
      first.send({ type: "start", options: baseOptions(scratch, { resume: gen1, lhc: { home: scratch.lhcHome, compact: policy } }) });
      await first.waitFor(() => first.logHas("resumed thread"), "resumed-thread log line");
      const served = first.stderr.find((l) => l.includes(`is at or past the compact trigger ${policy.trigger}; compacting before the next prompt`));
      const compactLine = first.stderr.find((l) => l.includes("[lhc compact:auto]"));
      const after = await usageOf(first, 1);
      const compacted = generationFrom(first);
      assert((await first.stop()) === 0, "resume sidecar did not exit 0");
      first.saveEvidence(evidenceDir);
      assert(served && compactLine?.includes(`(target ${policy.target})`), "the resume past the trigger did not compact to the target before start returned");
      assert(after < policy.trigger, `the first reading after the compact, ${after} tokens, is past the trigger ${policy.trigger}`);
      const again = new Sidecar(scratch, "restart");
      again.send({ type: "start", options: baseOptions(scratch, { resume: compacted }) });
      await again.waitFor(() => again.logHas("resumed thread"), "restart resumed-thread log line");
      const restarted = await usageOf(again, 1);
      assert((await again.stop()) === 0, "restart sidecar did not exit 0");
      again.saveEvidence(evidenceDir);
      assert(!again.logHas("served context") && !again.logHas("[lhc compact"), "the restart onto the compacted view compacted again");
      assert(restarted === after, `the restart reads ${restarted} tokens, not the ${after} the compacted generation served`);
      return `base prompt ${base} tokens; trigger ${policy.trigger} target ${policy.target}; ${/served context (\d+)/.exec(served)[1]} -> ${after} tokens after the compact, ${restarted} on restart, no second compact`;
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

  async "client-ops"(evidenceDir) {
    const scratch = new Scratch("client-ops");
    try {
      const { gen1, anchors } = await seedCaptured(scratch, PA_TURNS);
      const { compacted } = await compactOnce(scratch, "compact", { resume: gen1 }, evidenceDir);
      const agentId = await writeSubagentFixture(scratch, compacted, "toolu_after_compact");
      const hostHome = join(scratch.dir, "host-home");
      mkdirSync(hostHome, { recursive: true });
      const ops = await runClientOps(scratch, hostHome, [gen1, compacted, agentId, anchors[0], scratch.lhcHome, scratch.cwd, scratch.claudeHome]);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "client-ops.json"), `${JSON.stringify({ gen1, compacted, agentId, code: ops.code, ...ops.value }, null, 2)}\n`);
      writeFileSync(join(evidenceDir, "client-ops.stderr.log"), ops.stderr);
      assert(ops.code === 0, `the client host exited ${ops.code}: ${ops.stderr.trim().split("\n").at(-1)}`);
      const { entry, fork, forkMessages, viaFirst, agent, unknown, refused, inProcessForkMs } = ops.value;
      assert(entry === pathToFileURL(join(DIST, "client/index.js")).href, `the host imported ${entry}`);
      const forkFile = scratch.projected(fork.value.sessionId) ?? "";
      writeFileSync(join(evidenceDir, "projected-fork.jsonl"), forkFile);
      assert(forkFile.includes("KEEP-TURN answer one") && !forkFile.includes("REMOVED-TURN"), "the fork in the operation's Claude home does not end at KEEP");
      assert(fork.value.headMessageId === JSON.parse(forkFile.trim().split("\n").filter((l) => JSON.parse(l).uuid).at(-1)).uuid, "headMessageId is not the fork file's last message");
      assert(!existsSync(join(hostHome, ".claude", "projects")), "an operation wrote under the host's own Claude home");
      assert(JSON.stringify(forkMessages).includes("KEEP-TURN answer one") && !JSON.stringify(forkMessages).includes("REMOVED-TURN"), "getSessionMessages(fork) does not read the fork");
      assert(viaFirst.length > 0 && viaFirst.every((m) => m.session_id === compacted), "getSessionMessages(gen1) did not read the compacted generation");
      assert(agent.length === 2 && agent[0].parent_tool_use_id === "toolu_after_compact", `getSubagentMessages(gen1): ${JSON.stringify(agent)}`);
      assert(refused === `no LHC thread holds the Claude session ${unknown}`, `forkSession of an unknown id answered ${refused}`);
      return `forkSession from claude-lhc/client in ${fork.ms}ms (in-process ${inProcessForkMs}ms) wrote its projection under the operation's CLAUDE_CONFIG_DIR only; getSessionMessages and getSubagentMessages read across generations; an unknown id rejects by name`;
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
      const agentId = await writeSubagentFixture(scratch, compacted, "toolu_after_compact");
      const agent = await callInScratchEnv(scratch, "getSubagentMessages", [gen1, agentId, store]);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "history.json"), `${JSON.stringify({ gen1, compacted, viaFirst: viaFirst.value, agent: agent.value }, null, 2)}\n`);
      assert(viaFirst.code === 0 && viaCurrent.code === 0 && agent.code === 0, `library call failed: ${viaFirst.error ?? viaCurrent.error ?? agent.error}`);
      assert(scratch.projected(gen1) === null, "gen1 has a native file; the drive needs it to have none");
      assert(viaFirst.value.length > 0 && viaFirst.value.every((m) => m.session_id === compacted), "getSessionMessages(gen1) did not read the compacted generation");
      assert(JSON.stringify(viaFirst.value) === JSON.stringify(viaCurrent.value), "gen1 and the compacted id read different messages");
      assert(JSON.stringify(viaFirst.value).includes("REMOVED-TURN answer two"), "the current generation lost a turn");
      assert(agent.value.length === 2 && agent.value[0].parent_tool_use_id === "toolu_after_compact", `getSubagentMessages(gen1): ${JSON.stringify(agent.value)}`);

      const plain = randomUUID();
      const stockFile = await writeStockSession(scratch, plain, "STOCK-PROMPT");
      const plainAgent = await writeSubagentFixture(scratch, plain, "toolu_stock");
      const stockMessages = await callInScratchEnv(scratch, "getSessionMessages", [plain, store]);
      const stockAgent = await callInScratchEnv(scratch, "getSubagentMessages", [plain, plainAgent, store]);
      const byName = `no LHC thread holds the Claude session ${plain}`;
      const inspected = await inspectThroughClient(scratch, [gen1, compacted, plain]);
      const corrupt = join(scratch.dir, "corrupt-lhc");
      mkdirSync(corrupt);
      writeFileSync(join(corrupt, "registry.sqlite"), "not a sqlite database\n".repeat(64));
      const unreadable = await inspectThroughClient(scratch, [gen1], corrupt);
      const absent = join(scratch.dir, "absent-lhc");
      const empty = await inspectThroughClient(scratch, [gen1, plain], absent);
      writeFileSync(join(evidenceDir, "unknown-alias.json"), `${JSON.stringify({ plain, stockFile: existsSync(stockFile), getSessionMessages: { code: stockMessages.code, error: stockMessages.error, value: stockMessages.value }, getSubagentMessages: { code: stockAgent.code, error: stockAgent.error, value: stockAgent.value } }, null, 2)}\n`);
      writeFileSync(join(evidenceDir, "inspect.json"), `${JSON.stringify({ ids: [gen1, compacted, plain], inspected, unreadable: { code: unreadable.code, error: unreadable.error, starts: unreadable.starts }, absent: { ...empty, storeExists: existsSync(absent) } }, null, 2)}\n`);
      assert(stockMessages.code !== 0 && stockMessages.error === byName && stockMessages.value === undefined, `getSessionMessages of an unknown id with a stock file answered ${stockMessages.error ?? JSON.stringify(stockMessages.value)}`);
      assert(stockAgent.code !== 0 && stockAgent.error === byName && stockAgent.value === undefined, `getSubagentMessages of an unknown id with a stock subagent answered ${stockAgent.error ?? JSON.stringify(stockAgent.value)}`);
      assert(inspected.code === 0 && inspected.starts === 1, `inspectSessions exited ${inspected.code} after ${inspected.starts} sidecar starts: ${inspected.error}`);
      const [first, current, unknown] = inspected.value;
      assert(first.kind === "managed" && current.kind === "managed" && first.threadId === current.threadId, `gen1 and the compacted id: ${JSON.stringify(inspected.value)}`);
      assert(first.currentSessionId === compacted && current.currentSessionId === compacted, `the current session is not the compacted generation: ${JSON.stringify(inspected.value)}`);
      assert(unknown.kind === "unknown", `the stock id inspected as ${JSON.stringify(unknown)}`);
      assert(unreadable.code !== 0 && /^LHC registry read failed: /.test(unreadable.error ?? ""), `an unreadable registry answered ${unreadable.error ?? JSON.stringify(unreadable.value)}`);
      assert(empty.code === 0 && empty.value.every((a) => a.kind === "unknown") && !existsSync(absent), `an absent store answered ${JSON.stringify(empty.value)} and exists=${existsSync(absent)}`);
      return `getSessionMessages(gen1) reads compacted gen ${compacted.slice(0, 8)} (${viaFirst.value.length} messages; gen1 has no file); getSubagentMessages(gen1) finds an agent under the compacted gen; an unknown id fails by name with a stock file under it; inspectSessions answers managed, managed, unknown from 1 sidecar start, a store error for an unreadable registry, and unknown for an absent store with no file created`;
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
    const ask = "List every secret word I asked you to remember in this conversation, comma-separated, in the order I gave them. If there were none, say NONE. Reply with the words only.";
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
      const forked = await callInScratchEnv(scratch, "forkSession", [gen1, { lhc: { home: scratch.lhcHome }, dir: scratch.cwd, upToMessageId: kept.lastAssistantUuid }], { live: true, entry: "client/index.js", childEnvAsOpEnv: true });
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
      assert(answers.fork.includes("KEEP-ALPHA") && !answers.fork.includes("REMOVED-BRAVO"), `the fork does not end at the first turn: ${answers.fork}`);
      assert(answers.source.includes("KEEP-ALPHA") && answers.source.includes("REMOVED-BRAVO"), `the source lost a word: ${answers.source}`);
      return `fork from claude-lhc/client at the first turn answers "${answers.fork.trim()}"; source answers "${answers.source.trim()}"`;
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
      const ids = [gen1, compacted, randomUUID()];
      const inspected = await inspectThroughClient(scratch, ids, scratch.lhcHome, { live: true });
      writeFileSync(join(evidenceDir, "inspect.json"), `${JSON.stringify({ ids, ...inspected }, null, 2)}\n`);
      assert(inspected.code === 0 && inspected.starts === 1, `inspectSessions exited ${inspected.code} after ${inspected.starts} sidecar starts: ${inspected.error}`);
      const [first, current, unknown] = inspected.value;
      assert(first.kind === "managed" && current.kind === "managed" && first.threadId === current.threadId && unknown.kind === "unknown", `inspectSessions answered ${JSON.stringify(inspected.value)}`);
      return `agent ${agentId} launched in compacted gen ${compacted.slice(0, 8)}; getSubagentMessages(gen1) returned ${messages.value.length} messages, launch ${messages.value[0].parent_tool_use_id}; inspectSessions(gen1, compacted, random) answered managed, managed, unknown on thread ${first.threadId} from 1 sidecar start`;
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

  async "packed-install"(evidenceDir) {
    const scratch = new Scratch("packed-install");
    const assembled = join(REPO, "build", basename(scratch.dir));
    const project = join(scratch.dir, "project");
    const log = [];
    const run = (cmd, args, cwd, env = process.env) => {
      log.push(`$ ${cmd} ${args.join(" ")}`);
      log.push(execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000, killSignal: "SIGKILL" }).trim());
      return log.at(-1);
    };
    try {
      run("pnpm", ["--filter", "claude-lhc", "assemble:npm", "--out", assembled], REPO);
      const tarball = join(scratch.dir, run("npm", ["pack", "--pack-destination", scratch.dir, "--silent"], assembled).split("\n").at(-1));
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "packed-install-check", private: true, type: "module" })}\n`);
      run("npm", ["install", "--no-audit", "--no-fund", tarball], project);
      writeFileSync(join(project, "check.mjs"), [
        `import { query } from "claude-lhc";`,
        `const [cwd, lhcHome, claudeHome] = process.argv.slice(2);`,
        `const stderr = [];`,
        `const q = query({ prompt: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } }, options: { cwd, model: "claude-sonnet-5", pathToClaudeCodeExecutable: process.env.CLAUDE_BIN ?? "claude", env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome }, stderr: (d) => stderr.push(d), lhc: { home: lhcHome, compact: { trigger: 700000, target: 140000 } } } });`,
        `const usage = await q.getContextUsage();`,
        `q.close();`,
        `for await (const _ of q) {}`,
        `process.stdout.write(JSON.stringify({ entry: import.meta.resolve("claude-lhc"), created: /created thread \\S+/.exec(stderr.join(""))?.[0] ?? null, window: usage?.rawMaxTokens ?? null }));`,
      ].join("\n"));
      const out = JSON.parse(run(process.execPath, ["check.mjs", scratch.cwd, scratch.lhcHome, scratch.claudeHome], project, { ...process.env, CLAUDE_LHC_NO_INFERENCE: "1" }));
      await until(() => scratchProcesses(scratch).length === 0, "the packed sidecar and its claude to exit after close()", 15_000);
      assert(out.entry === pathToFileURL(join(project, "node_modules/claude-lhc/dist/index.js")).href, `claude-lhc resolved to ${out.entry}, not the installed tarball`);
      assert(existsSync(join(project, "node_modules/claude-lhc/node_modules/lhc/dist/index.js")), "the tarball does not bundle the lhc core");
      assert(out.created && typeof out.window === "number", `the packed query() did not start a thread and answer getContextUsage: ${JSON.stringify(out)}`);
      assert(scratch.threads().length === 1, `expected 1 thread file, got ${scratch.threads().length}`);
      const installed = JSON.parse(readFileSync(join(project, "node_modules/claude-lhc/package.json"), "utf8"));
      assert(installed.sideEffects === false && installed.exports?.["./client"], `the installed manifest lacks sideEffects: false or ./client: ${JSON.stringify({ sideEffects: installed.sideEffects, exports: installed.exports })}`);
      const forbidden = await bundleInstalledClient(project, evidenceDir);
      assert(forbidden.length === 0, `the installed claude-lhc/client bundles ${forbidden.join(", ")}`);
      return `${basename(tarball)} installed in a scratch project; query() from its dist/index.js ran the default sidecar: ${out.created}, window ${out.window}; the installed claude-lhc/client bundles with no lhc, effect, js-tiktoken or Agent SDK module`;
    } finally {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "packed-install.log"), `${log.join("\n")}\n`);
      rmSync(assembled, { recursive: true, force: true });
      try { rmdirSync(dirname(assembled)); } catch {}
      scratch.cleanup();
    }
  },

  async "prompt-order-live"(evidenceDir) {
    const gate = liveAuth();
    if (gate.skip) return gate;
    const together = await livePromptOrder(join(evidenceDir, "held-one-at-a-time"), "held-one-at-a-time", { trigger: 300000, target: 180000 }, async (s) => {
      const [compact, one, two] = [randomUUID(), randomUUID(), randomUUID()];
      s.send(userFrame("/compact", compact));
      s.send(userFrame("Reply with exactly the word ONE.", one));
      s.send(userFrame("Reply with exactly the word TWO.", two));
      s.send({ type: "end" });
      await s.waitFor(() => s.exitCode !== undefined, "every input answered", 600_000);
      const m = s.msgs();
      const results = resultsIn(m);
      assert(results.length === 3, `expected 3 results, got ${results.length}`);
      assert(String(m[results[1]].result).includes("ONE") && String(m[results[2]].result).includes("TWO"), `results ${JSON.stringify(results.map((i) => m[i].result))}`);
      assert(lifecycleAt(m, one) > boundaryAt(m, "manual"), "ONE reached the CLI before the /compact ended");
      assert(lifecycleAt(m, two) > results[1], "TWO reached the CLI before ONE had its result");
      assert(settlesCompact(m[results[0]], compact), `the /compact's result does not carry its uuid and local_command: ${JSON.stringify(m[results[0]])}`);
      assert(lifecycleAt(m, compact, "completed") > results[0], "the /compact's completed lifecycle did not follow its result");
      return "TWO reached the CLI after ONE's result; the /compact's result carries its uuid";
    });
    const pending = await livePromptOrder(join(evidenceDir, "pending-across-swap"), "pending-across-swap", FILLER_POLICY, async (s) => {
      const [steer, queued] = [randomUUID(), randomUUID()];
      const toolCalls = () => s.msgs().filter((m) => m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use")).length;
      s.send(userFrame(PENDING_TURN));
      await s.waitFor(() => toolCalls() >= 2, "the tool call whose request is past the trigger", 180_000);
      s.send(userFrame("Also reply with the word PENDING.", steer));
      await s.waitFor(() => s.logHas("compact (auto) due mid-turn"), "the compact falling due", 180_000);
      s.send(userFrame("Reply with exactly the word QUEUED.", queued));
      s.send({ type: "end" });
      await s.waitFor(() => s.exitCode !== undefined, "every input answered", 900_000);
      const m = s.msgs();
      const starts = m.filter((x) => x.type === "command_lifecycle" && x.command_uuid === steer && x.state === "started").length;
      const pendingResult = resultsIn(m).find((i) => String(m[i].result).includes("PENDING"));
      const queuedResult = resultsIn(m).find((i) => String(m[i].result).includes("QUEUED"));
      assert(starts === 1, `the prompt sent while the compact was pending started ${starts} times`);
      assert(pendingResult !== undefined, "the prompt sent while the compact was pending got no answer");
      assert(boundaryAt(m, "auto") > -1 && boundaryAt(m, "auto") < pendingResult, "no automatic compact before the pending prompt's answer");
      assert(queuedResult !== undefined && queuedResult > pendingResult && !String(m[queuedResult].result).includes("PENDING"), "the prompt sent after the compact fell due did not get a result of its own after the pending one");
      assert(lifecycleAt(m, queued, "started") > pendingResult, "the prompt sent after the compact fell due reached the CLI before the turn ended");
      const path = s.logHas("waiting for the CLI to start a prompt it holds") ? "the CLI held it and the compact waited" : "the sidecar held it";
      return `the pending prompt started once, ${path}; the prompt sent after the compact fell due got its own result`;
    });
    const behindHeld = await livePromptOrder(join(evidenceDir, "compact-behind-held"), "compact-behind-held", FILLER_POLICY, async (s) => {
      const [held, compact] = [randomUUID(), randomUUID()];
      s.send(userFrame(HELD_TURN));
      await s.waitFor(() => s.msgs().some((m) => m.subtype === "status" && m.status === "compacting"), "a mid-turn compact", 180_000);
      const compactingAt = s.msgs().length - 1;
      s.send(userFrame("Reply with exactly the word HELD.", held));
      s.send(userFrame("/compact", compact));
      s.send({ type: "end" });
      await s.waitFor(() => s.exitCode !== undefined, "every input answered", 900_000);
      const m = s.msgs();
      const continued = resultsIn(m).find((i) => i > compactingAt);
      const heldResult = resultsIn(m).find((i) => i > lifecycleAt(m, held, "started") && String(m[i].result).includes("HELD"));
      const manual = boundaryAt(m, "manual");
      assert(lifecycleAt(m, held, "started") > continued, "the held prompt started before the continued turn's result");
      assert(heldResult !== undefined, "the held prompt got no result of its own");
      assert(manual > heldResult, "the /compact ran before the held prompt's result");
      assert(m[resultsIn(m).at(-1)].result === "", "the /compact's own result is not last");
      assert(settlesCompact(m[resultsIn(m).at(-1)], compact), "the /compact's result does not carry its uuid and local_command");
      return "the /compact ran after the held prompt's result";
    });
    return `${together}; ${pending}; ${behindHeld}`;
  },

  async "resume-cache-live"(evidenceDir) {
    const gate = liveAuth();
    if (gate.skip) return gate;
    const lines = Number(process.env.RESUME_CACHE_LINES ?? 8000);
    const resumes = Number(process.env.RESUME_CACHE_RESUMES ?? 2);
    const sides = (process.env.RESUME_CACHE_SIDES ?? "stock,lhc").split(",");
    const compact = process.env.RESUME_CACHE_COMPACT === "1";
    const proxy = await captureProxy(evidenceDir);
    const report = { model: process.env.MODEL ?? "claude-sonnet-5", auth: gate.auth, lines, resumes, compact, stock: [], lhc: [], lhcAfterCompact: [] };
    const save = () => writeFileSync(join(evidenceDir, "results.json"), `${JSON.stringify({ ...report, requests: proxy.requests }, null, 2)}\n`);
    const scratches = [];
    const sidecars = [];
    const scratchFor = (side) => {
      const scratch = new Scratch(`resume-cache-${side}`);
      scratch.home = join(scratch.dir, "home");
      mkdirSync(scratch.home, { recursive: true });
      scratches.push(scratch);
      return scratch;
    };
    try {
      if (sides.includes("stock")) {
        const sdk = await import(pathToFileURL(createRequire(join(REPO, "packages/claude-lhc/package.json")).resolve("@anthropic-ai/claude-agent-sdk")).href);
        const scratch = scratchFor("stock");
        const sessionId = randomUUID();
        report.stock.push((await stockCacheTurn(sdk, scratch, proxy, "stock-growth", CACHE_GROWTH(lines), { sessionId })).row);
        for (let i = 1; i <= resumes; i += 1) {
          report.stock.push((await stockCacheTurn(sdk, scratch, proxy, `stock-resume-${i}`, CACHE_RESUME, { resume: sessionId })).row);
          save();
        }
      }
      let lastLhc;
      if (sides.includes("lhc")) {
        const scratch = scratchFor("lhc");
        report.lhc.push(...(await lhcCacheTurn(scratch, proxy, sidecars, "lhc-growth", [CACHE_GROWTH(lines)], { sessionId: randomUUID() })));
        for (let i = 1; i <= resumes; i += 1) {
          report.lhc.push(...(await lhcCacheTurn(scratch, proxy, sidecars, `lhc-resume-${i}`, [CACHE_RESUME], { resume: report.lhc.at(-1).session_id })));
          save();
        }
        if (compact) {
          report.lhcAfterCompact.push(...(await lhcCacheTurn(scratch, proxy, sidecars, "lhc-compact", ["/compact", CACHE_RESUME], { resume: report.lhc.at(-1).session_id })));
          for (let i = 1; i <= 2; i += 1)
            report.lhcAfterCompact.push(...(await lhcCacheTurn(scratch, proxy, sidecars, `lhc-compact-resume-${i}`, [CACHE_RESUME], { resume: report.lhcAfterCompact.at(-1).session_id })));
        }
        lastLhc = report.lhc;
      }
      const failed = [...report.stock, ...report.lhc, ...report.lhcAfterCompact].find((r) => r.subtype !== "success" || r.is_error);
      assert(failed === undefined, `${failed?.label} did not succeed: ${failed?.subtype}`);
      const low = (rows) => rows.filter((r) => r.label.includes("-resume-") && !(r.cache_fraction >= 0.8));
      assert(low(report.stock).length === 0, `stock resumes below 0.8 (${low(report.stock).map((r) => `${r.label} ${r.cache_fraction}`).join(", ")}): the endpoint is the limiter, so rerun before judging claude-lhc`);
      if (lastLhc !== undefined && resumes >= 2) {
        const [first, second] = [proxy.body("lhc-resume-1"), proxy.body("lhc-resume-2")];
        assert(first && second, "no captured request for an LHC resume");
        const at = environmentReminderAt(first);
        report.reminder = { resume1Index: at, resume2Index: environmentReminderAt(second), sameText: at >= 0 && messageText(first.messages[at]) === messageText(second.messages[at]) };
      }
      save();
      const lhcLow = low([...report.lhc, ...report.lhcAfterCompact]);
      assert(lhcLow.length === 0, `LHC resumes below 0.8: ${lhcLow.map((r) => `${r.label} ${r.cache_fraction?.toFixed(4)}`).join(", ")}`);
      if (report.reminder !== undefined)
        assert(report.reminder.resume1Index >= 0 && report.reminder.resume2Index === report.reminder.resume1Index && report.reminder.sameText, `the historical environment reminder moved between LHC resumes: ${JSON.stringify(report.reminder)}`);
      const fractions = (rows) => rows.filter((r) => r.label.includes("-resume-")).map((r) => r.cache_fraction.toFixed(3)).join("/");
      return `auth=${gate.auth} lines=${lines}; stock resumes ${fractions(report.stock) || "not run"}; LHC resumes ${fractions(report.lhc) || "not run"}${compact ? `, after /compact ${fractions(report.lhcAfterCompact)}` : ""}${report.reminder ? `; environment reminder held at messages[${report.reminder.resume1Index}]` : ""}`;
    } finally {
      for (const s of sidecars) if (s.exitCode === undefined) await s.stop();
      mkdirSync(evidenceDir, { recursive: true });
      for (const s of sidecars) s.saveEvidence(evidenceDir);
      save();
      await proxy.close();
      for (const scratch of scratches) scratch.cleanup();
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
      ? ["start", "start-no-home", "compact", "compact-policy", "restart", "resume-superseded-alias", "resume-unknown", "resume-empty", "thread-start", "rollback", "rollback-unknown-anchor", "rollback-restart", "rollback-synthetic-anchor", "rollback-compact", "rollback-projected-anchor", "window-shrink", "compact-above-base", "controls", "controls-refused", "set-compact-policy", "fork", "history", "client-ops", "client", "turn", "rollback-live", "rollback-live-compact", "controls-live", "fork-live", "subagent-live", "prompt-order-live", "resume-cache-live", "consumer"]
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
