#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const ENTRY = join(REPO, "packages/claude-lhc/dist/sidecar.js");
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

class Scratch {
  constructor(label) {
    this.dir = mkdtempSync(join(SCRATCH_ROOT, `verify-claude-lhc-${label}-`));
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
  cleanup() {
    if (process.env.VERIFY_KEEP_SCRATCH === "1") console.log(`VERIFY-CLAUDE-LHC kept scratch: ${this.dir}`);
    else rmSync(this.dir, { recursive: true, force: true });
  }
}

class Sidecar {
  constructor(scratch, label) {
    this.label = label;
    this.frames = [];
    this.stderr = [];
    this.error = null;
    this.waiters = [];
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
const threadIdFrom = (s) => /created thread (\S+)|resumed thread (\S+)/.exec(s.stderr.join("\n"))?.slice(1).find(Boolean);

function assert(cond, reason) { if (!cond) throw new Error(reason); }

const LIVE_AUTH_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];

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
      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: scratch.claudeHome, T3CODE_LHC_HOME: scratch.lhcHome, TMPDIR: scratch.cwd, DISABLE_AUTOUPDATER: "1" };
      delete env.T3CODE_LHC_NO_INFERENCE;
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
  const names = which === "all" ? ["start", "compact", "restart", "resume-superseded-alias", "resume-unknown", "turn"] : [which];
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
