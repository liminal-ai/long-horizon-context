#!/usr/bin/env node
// Run case files: each file = meta line + marker + full prompt (sent verbatim
// as one user message). Usage:
//   node turn-compression/run.mjs t3 t5 [--model openai/gpt-5.4-mini] [--effort none] [--repeats 1]
import { readFileSync, appendFileSync } from "node:fs";
import { estimateTokens } from "../../../dist/index.js";

const PROVIDERS = {
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY" },
  cerebras: { url: "https://api.cerebras.ai/v1/chat/completions", keyEnv: "CEREBRAS_API_KEY" },
};

const cases = [];
const opts = { model: "openai/gpt-5.4-mini", effort: "none", repeats: 1, provider: "openrouter" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--model") opts.model = argv[++i];
  else if (a === "--effort") opts.effort = argv[++i];
  else if (a === "--repeats") opts.repeats = Number(argv[++i]);
  else if (a === "--provider") opts.provider = argv[++i];
  else cases.push(a.replace(/\.txt$/, ""));
}
if (cases.length === 0) { console.error("no cases given"); process.exit(1); }
const provider = PROVIDERS[opts.provider];
if (!provider) throw new Error(`unknown provider ${opts.provider} (${Object.keys(PROVIDERS).join(", ")})`);
const key = process.env[provider.keyEnv];
if (!key) throw new Error(`missing ${provider.keyEnv} (source ~/.lhc/.env)`);

for (const name of cases) {
  const raw = readFileSync(`turn-compression/cases/${name}.txt`, "utf8");
  const nl = raw.indexOf("\n");
  const meta = JSON.parse(raw.slice(0, nl));
  const afterMeta = raw.slice(nl + 1);
  const markerEnd = afterMeta.indexOf("\n");
  const prompt = afterMeta.slice(markerEnd + 1);
  const promptTokens = estimateTokens(prompt);

  for (let run = 1; run <= opts.repeats; run += 1) {
    const t0 = performance.now();
    const body = { model: opts.model, messages: [{ role: "user", content: prompt }] };
    if (opts.provider === "openrouter") { body.reasoning = { effort: opts.effort }; body.usage = { include: true }; }
    else if (opts.effort !== "none") body.reasoning_effort = opts.effort;
    const res = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!payload.choices?.length && !payload.error) payload.error = { httpStatus: res.status, body: JSON.stringify(payload).slice(0, 300) };
    const elapsed = Math.round(performance.now() - t0);
    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? "";
    const outTok = estimateTokens(text);
    const ratio = Number((outTok / meta.inputTokens * 100).toFixed(1));
    const inWindow = outTok >= meta.min && outTok <= meta.max;
    const row = {
      case: name, run, model: opts.model, effort: opts.effort, provider: opts.provider, routedProvider: payload.provider ?? null,
      promptTokens, inputTokens: meta.inputTokens, window: [meta.min, meta.max], aim: meta.aim,
      outputTokens: outTok, ratio, inWindow,
      finishReason: choice?.finish_reason ?? null, nativeFinish: choice?.native_finish_reason ?? null,
      elapsed, usage: payload.usage ?? null, cost: payload.usage?.cost ?? null, error: payload.error ?? null, output: text,
    };
    appendFileSync("turn-compression/results/runs.jsonl", JSON.stringify(row) + "\n");
    console.log(`${name} run ${run} [${opts.model} ${opts.effort}]: out=${outTok}t ratio=${ratio}% ${inWindow ? "IN-WINDOW" : "out"} finish=${row.finishReason} ${elapsed}ms${row.error ? " ERROR " + JSON.stringify(row.error).slice(0, 80) : ""}`);
  }
}
