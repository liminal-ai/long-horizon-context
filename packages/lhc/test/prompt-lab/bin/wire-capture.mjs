#!/usr/bin/env node
// Run specimen fixtures through the REAL production bridge (pi-lhc createModelCall
// -> pi-ai -> codex lane) with global fetch wrapped to capture the exact wire
// payload. Auth headers are stripped from captures.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { estimateTokens } from "../../../dist/index.js";

const PI_LHC_DIST = "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/dist";
const codingAgent = await import(PI_LHC_DIST + "/../node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { ModelRegistry, AuthStorage } = codingAgent;
const { createModelCall } = await import(PI_LHC_DIST + "/inference/model-call.js");

// --- fetch wrap: capture outgoing requests, pass through untouched ---
const captures = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  let body = init?.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
  const headerNames = init?.headers ? Object.keys(Object.fromEntries(new Headers(init.headers))) : [];
  captures.push({ url, method: init?.method ?? "GET", headerNames, body });
  return realFetch(input, init);
};

const registry = ModelRegistry.create(AuthStorage.create());
const modelCall = createModelCall({ modelRegistry: registry });

const outDir = "/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/prompt-lab/results/wire";
mkdirSync(outDir, { recursive: true });

for (const spec of process.argv.slice(2)) {
  const fixture = JSON.parse(readFileSync(`/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/test/prompt-lab/specimens/${spec}-detailed_turn_compression.json`, "utf8"));
  captures.length = 0;
  const t0 = performance.now();
  const result = await modelCall({
    provider: "openai-codex",
    model: "gpt-5.4-mini",
    messages: fixture.messages,
    thinking: "none",
  });
  const elapsed = Math.round(performance.now() - t0);
  const text = result.ok ? result.text : "";
  const outTok = estimateTokens(text);
  const record = {
    specimen: spec, elapsed,
    result: result.ok ? { outputTokens: outTok, ratio: Number((outTok / fixture.inputTokens * 100).toFixed(1)) } : result,
    wire: captures,
    output: text,
  };
  writeFileSync(`${outDir}/${spec}-wire.json`, JSON.stringify(record, null, 2));
  console.log(`${spec}: ${result.ok ? `out=${outTok}t ratio=${record.result.ratio}%` : `FAILED ${result.kind}: ${result.message?.slice(0, 100)}`} elapsed=${elapsed}ms requests=${captures.length}`);
}
