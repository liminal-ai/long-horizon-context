#!/usr/bin/env node
// Replay a captured specimen fixture N times against a model, byte-identical
// messages by default, and report output/input ratio per run.
// Usage: node replay.mjs --fixture specimens/t2-*.json --model openai/gpt-5.4-mini --repeats 5 --out results/baseline.jsonl
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { estimateTokens } from "../../../dist/index.js";

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--fixture") args.fixture = next();
  else if (a === "--model") args.model = next();
  else if (a === "--repeats") args.repeats = Number(next());
  else if (a === "--out") args.out = next();
  else if (a === "--messages-file") args.messagesFile = next(); // override: swap prompt, keep everything else
  else if (a === "--endpoint") args.endpoint = next();
  else if (a === "--key-env") args.keyEnv = next();
  else if (a === "--temperature") args.temperature = Number(next());
  else if (a === "--thinking") args.thinking = next();
  else throw new Error(`unknown arg ${a}`);
}
const fixture = JSON.parse(readFileSync(args.fixture, "utf8"));
const messages = args.messagesFile ? JSON.parse(readFileSync(args.messagesFile, "utf8")) : fixture.messages;
const model = args.model ?? "openai/gpt-5.4-mini";
const repeats = args.repeats ?? 1;
const endpoint = args.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
const key = process.env[args.keyEnv ?? "OPENROUTER_API_KEY"];
if (!key) throw new Error("missing API key env");

const body = { model, messages };
if (args.temperature !== undefined) body.temperature = args.temperature;
// Always send reasoning effort explicitly (production sends reasoningEffort:"none";
// the prior derivation-testing harness did the same). Absent param = provider default.
// OpenAI's own API takes reasoning_effort; OpenRouter takes reasoning:{effort}.
if (endpoint.includes("api.openai.com")) body.reasoning_effort = args.thinking ?? "none";
else body.reasoning = { effort: args.thinking ?? "none" };

for (let run = 1; run <= repeats; run += 1) {
  const t0 = performance.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const payload = await res.json(); // fetch resolves at headers; body streams during json()
  const elapsed = Math.round(performance.now() - t0);
  const text = payload.choices?.[0]?.message?.content ?? "";
  const outTok = estimateTokens(text);
  const ratio = fixture.inputTokens ? outTok / fixture.inputTokens : null;
  const row = {
    specimen: fixture.specimen, run, model,
    inputTokens: fixture.inputTokens, outputTokens: outTok,
    ratio: ratio === null ? null : Number((ratio * 100).toFixed(1)),
    window: fixture.ratios ? [fixture.ratios.min * 100, fixture.ratios.max * 100] : null,
    elapsed, usage: payload.usage ?? null,
    error: payload.error ?? (res.ok ? null : { status: res.status }),
    output: text,
  };
  if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); appendFileSync(args.out, JSON.stringify(row) + "\n"); }
  console.log(`${fixture.specimen} run ${run}: out=${outTok}t ratio=${row.ratio}% elapsed=${elapsed}ms${row.error ? " ERROR " + JSON.stringify(row.error).slice(0, 120) : ""}`);
}
