#!/usr/bin/env node
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { parseFixtureRecord } from "./lib/fixture.mjs";
import { classifyToolResult } from "./lib/classify.mjs";
import { buildPrompt } from "./lib/prompt.mjs";
import { callChatCompletion } from "./lib/model-client.mjs";

function usage() {
  console.log(`Usage:
  node derivation-testing/tool_result_summary/tool-result-summary-cli.mjs \
    --examples derivation-testing/tool_result_summary/set-a.jsonl \
    --out derivation-testing/tool_result_summary/results/set-a-gpt54mini.jsonl \
    --model openai/gpt-5.4-mini \
    --extra-json '{"provider":{"only":["openai"],"allow_fallbacks":false}}'

Options:
  --examples PATH      JSONL fixtures
  --out PATH           JSONL results
  --model ID           OpenRouter model id
  --endpoint URL       Default: https://openrouter.ai/api/v1/chat/completions
  --key-env NAME       Default: OPENROUTER_API_KEY
  --extra-json JSON    Extra request fields, e.g. provider lock
  --timeout-ms N       Per-call timeout. Default: 60000
  --dry-run            Do not call model; emit prompt/classification only
`);
}

function parseArgs(argv) {
  const args = {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    keyEnv: "OPENROUTER_API_KEY",
    model: "openai/gpt-5.4-mini",
    extraJson: "{}",
    dryRun: false,
    timeoutMs: 60000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--examples") args.examples = next();
    else if (arg === "--out") args.out = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--endpoint") args.endpoint = next();
    else if (arg === "--key-env") args.keyEnv = next();
    else if (arg === "--extra-json") args.extraJson = next();
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg ${arg}`);
    }
  }
  if (!args.examples) throw new Error("Missing --examples");
  if (!args.out && !args.dryRun) throw new Error("Missing --out");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const extraJson = JSON.parse(args.extraJson);
  const rows = (await readFile(args.examples, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  if (args.out) await mkdir(dirname(args.out), { recursive: true });

  for (const record of rows) {
    const fixture = parseFixtureRecord(record);
    const classification = classifyToolResult(fixture);
    const prompt = buildPrompt({ fixture, classification });

    if (args.dryRun) {
      console.log(JSON.stringify({ id: fixture.id, classification, prompt }, null, 2));
      continue;
    }

    const result = await callChatCompletion({
      endpoint: args.endpoint,
      keyEnv: args.keyEnv,
      model: args.model,
      extraJson,
      messages: [
        { role: "system", content: "You summarize tool responses for a coding agent memory system." },
        { role: "user", content: prompt },
      ],
      timeoutMs: args.timeoutMs,
    });

    const output = {
      id: fixture.id,
      ok: result.ok,
      model: args.model,
      classification,
      summary: result.text?.trim() ?? "",
      status: result.status,
      totalMs: result.totalMs,
      headersMs: result.headersMs,
      usage: result.usage,
      error: result.error,
    };
    await appendFile(args.out, JSON.stringify(output) + "\n");
    const status = result.ok ? "OK" : "FAIL";
    console.log(`${status} ${fixture.id}: ${result.totalMs}ms ${classification.promptMode}/${classification.responseShape}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
