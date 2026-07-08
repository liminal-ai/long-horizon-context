#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

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

const mode = process.env.CODEX_LHC_FAKE_MODE ?? "success";
const systemPrompt = argValue("--system-prompt") ?? "";
const model = argValue("--model") ?? "";

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

const stdin = await readStdin();

if (mode === "stdin-file") {
  const outPath = process.env.CODEX_LHC_FAKE_STDIN_FILE;
  if (outPath === undefined || outPath === "") {
    console.error("CODEX_LHC_FAKE_STDIN_FILE required");
    process.exit(2);
  }
  writeFileSync(outPath, JSON.stringify({ stdin, systemPrompt, model }));
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

if (mode === "empty") {
  process.exit(0);
}

process.stdout.write(`echo:${stdin}`);
process.exit(0);
