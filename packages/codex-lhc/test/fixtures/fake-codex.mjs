#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function dateDirParts(date = new Date()) {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0"),
    stamp: date.toISOString().replace(/[:.]/g, "-").slice(0, 19),
  };
}

function defaultSessionId() {
  return process.env.CODEX_LHC_FAKE_SESSION_ID ?? "550e8400-e29b-41d4-a716-446655440099";
}

function codexHome() {
  return process.env.CODEX_LHC_FAKE_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function rolloutLines() {
  const source = process.env.CODEX_LHC_FAKE_ROLLOUT_FILE;
  if (source !== undefined && source !== "") {
    return readFileSync(source, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"));
  }

  const sessionId = defaultSessionId();
  return [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: {
        session_id: sessionId,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        originator: "codex-lhc-fake",
        cli_version: "0.0.0-fake",
        source: "exec",
      },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "sanitized user prompt" }],
      },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_fake_assistant",
        role: "assistant",
        content: [{ type: "output_text", text: "sanitized assistant response" }],
      },
    }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn_fake_complete",
        last_agent_message: "sanitized assistant response",
      },
    }),
  ];
}

function writeRolloutFile() {
  const home = codexHome();
  const parts = dateDirParts();
  const sessionId = defaultSessionId();
  const dir = join(home, "sessions", parts.year, parts.month, parts.day);
  mkdirSync(dir, { recursive: true });
  const rolloutPath = join(dir, `rollout-${parts.stamp}-${sessionId}.jsonl`);
  const lines = rolloutLines();
  writeFileSync(rolloutPath, `${lines.join("\n")}\n`);
  const marker = process.env.CODEX_LHC_FAKE_ROLLOUT_MARKER;
  if (marker !== undefined && marker !== "") {
    writeFileSync(marker, rolloutPath);
  }
  return rolloutPath;
}

function findRolloutForSession(root, sessionId) {
  const sessionsRoot = join(root, "sessions");
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(dir, entry);
      let stats;
      try {
        stats = statSync(child);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (stats.isFile() && entry.startsWith("rollout-") && entry.endsWith(`-${sessionId}.jsonl`)) {
        return child;
      }
    }
  }
  return undefined;
}

function resumeSessionIdFromArgv() {
  const resumeIndex = process.argv.indexOf("resume");
  if (resumeIndex < 0) return undefined;
  return process.argv[resumeIndex + 1];
}

const mode = process.env.CODEX_LHC_FAKE_MODE ?? "rollout";
const exitCode = Number.parseInt(process.env.CODEX_LHC_FAKE_EXIT_CODE ?? "0", 10);

if (mode === "hold-slot") {
  const sentinelPath = process.env.CODEX_LHC_FAKE_SENTINEL_FILE;
  if (sentinelPath !== undefined && sentinelPath !== "") {
    writeFileSync(sentinelPath, `${Date.now()}\n`, { flag: "a" });
  }
  const ms = Number.parseInt(process.env.CODEX_LHC_FAKE_SLEEP_MS ?? "200", 10);
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  process.stdout.write("held");
  process.exit(0);
}

if (mode === "immediate-exit") {
  console.error("OAuth login required");
  process.exit(1);
}

if (mode === "rollout") {
  writeRolloutFile();
  const stdin = await Promise.race([
    readStdin(),
    new Promise((resolve) => {
      const ms = Number.parseInt(process.env.CODEX_LHC_FAKE_STDIN_TIMEOUT_MS ?? "250", 10);
      setTimeout(() => resolve(""), ms);
    }),
  ]);
  process.stdout.write(stdin.length > 0 ? stdin : "codex-lhc-fake-ready\n");
  process.exit(Number.isFinite(exitCode) ? exitCode : 0);
}

if (mode === "empty") {
  process.exit(0);
}

if (mode === "resume-append") {
  const sessionId = resumeSessionIdFromArgv();
  if (sessionId === undefined || sessionId === "") {
    console.error("resume session id required");
    process.exit(2);
  }

  const marker = process.env.CODEX_LHC_FAKE_ARGV_FILE;
  if (marker !== undefined && marker !== "") {
    writeFileSync(marker, JSON.stringify(process.argv.slice(2)));
  }

  if (process.env.CODEX_LHC_FAKE_RESUME_SPAWN_FAIL === "1") {
    console.error("resume failed before append");
    process.exit(9);
  }

  const rolloutPath = findRolloutForSession(codexHome(), sessionId);
  if (rolloutPath === undefined) {
    console.error(`rollout not found for ${sessionId}`);
    process.exit(3);
  }

  const appendEnabled = process.env.CODEX_LHC_FAKE_RESUME_APPEND !== "0";
  if (appendEnabled) {
    const delay = Number.parseInt(process.env.CODEX_LHC_FAKE_RESUME_APPEND_DELAY_MS ?? "20", 10);
    await new Promise((resolve) => setTimeout(resolve, delay));
    appendFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: process.env.CODEX_LHC_FAKE_RESUME_TEXT ?? "resume append ok" }],
        },
      })}\n`,
    );
  }

  const ms = Number.parseInt(process.env.CODEX_LHC_FAKE_SLEEP_MS ?? "250", 10);
  await new Promise((resolve) => setTimeout(resolve, ms));
  process.stdout.write(`resumed:${sessionId}\n`);
  process.exit(Number.isFinite(exitCode) ? exitCode : 0);
}

const stdin = await readStdin();

if (mode === "stdin-file") {
  const outPath = process.env.CODEX_LHC_FAKE_STDIN_FILE;
  if (outPath === undefined || outPath === "") {
    console.error("CODEX_LHC_FAKE_STDIN_FILE required");
    process.exit(2);
  }
  writeFileSync(outPath, JSON.stringify({ stdin, model: argValue("--model") ?? "" }));
  process.stdout.write("ok");
  process.exit(0);
}

if (mode === "concurrency") {
  const counterPath = process.env.CODEX_LHC_FAKE_COUNTER_FILE;
  if (counterPath === undefined || counterPath === "") {
    console.error("CODEX_LHC_FAKE_COUNTER_FILE required");
    process.exit(2);
  }
  let current = 0;
  let peak = 0;
  try {
    const raw = readFileSync(counterPath, "utf8");
    const parsed = JSON.parse(raw);
    current = parsed.current ?? 0;
    peak = parsed.peak ?? 0;
  } catch {
    // fresh counter file
  }
  current += 1;
  peak = Math.max(peak, current);
  writeFileSync(counterPath, JSON.stringify({ current, peak }));
  await new Promise((resolve) => {
    setTimeout(resolve, Number.parseInt(process.env.CODEX_LHC_FAKE_SLEEP_MS ?? "200", 10));
  });
  try {
    const raw = readFileSync(counterPath, "utf8");
    const parsed = JSON.parse(raw);
    current = (parsed.current ?? 1) - 1;
    peak = parsed.peak ?? peak;
    writeFileSync(counterPath, JSON.stringify({ current, peak }));
  } catch {
    // ignore
  }
  process.stdout.write(`peak:${String(peak)}`);
  process.exit(0);
}

if (mode === "tick") {
  writeRolloutFile();
  let i = 0;
  setInterval(() => {
    i += 1;
    process.stdout.write(`tick${i}\r\n`);
  }, 50);
  await new Promise(() => {});
}

if (mode === "sleep") {
  const ms = Number.parseInt(process.env.CODEX_LHC_FAKE_SLEEP_MS ?? "120000", 10);
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
  process.stdout.write("late");
  process.exit(0);
}

if (mode === "auth") {
  console.error("OAuth login required");
  process.exit(1);
}

if (mode === "rate_limit") {
  console.error("429 rate limit exceeded");
  process.exit(1);
}

if (mode === "generic") {
  console.error("something went wrong");
  process.exit(2);
}

process.stdout.write(`echo:${stdin}`);
process.exit(Number.isFinite(exitCode) ? exitCode : 0);
