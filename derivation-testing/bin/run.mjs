#!/usr/bin/env node
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

function usage() {
  console.log(`Usage:
  node derivation-testing/bin/run.mjs \
    --derivation smoothed_prompt \
    --prompt derivation-testing/prompts/smoothed_prompt/poc-v1.md \
    --model openai/gpt-5.4-mini \
    --thinking none \
    --examples derivation-testing/examples/smoothed_prompt/set-a.jsonl \
    --out derivation-testing/results/run.jsonl

Inputs:
  --text "..." OR --text-file path OR --examples path.jsonl

Required:
  --prompt path
  --model provider/model-slug
  --out path unless --dry-run

Optional:
  --derivation name
  --thinking none|minimal|low|medium|high
  --provider openrouter
  --endpoint https://.../chat/completions
  --key-env OPENROUTER_API_KEY
  --temperature 0.2
  --max-tokens 800
  --extra-json '{"top_p":0.9}'
  --target-min-ratio 0.4
  --target-mid-ratio 0.5
  --target-max-ratio 0.6
  --var key=value
  --dry-run
`);
}

function parseArgs(argv) {
  const out = { vars: {}, provider: "openrouter", keyEnv: "OPENROUTER_API_KEY" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--derivation") out.derivation = next();
    else if (arg === "--prompt") out.prompt = next();
    else if (arg === "--text") out.text = next();
    else if (arg === "--text-file") out.textFile = next();
    else if (arg === "--examples") out.examples = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--provider") out.provider = next();
    else if (arg === "--endpoint") out.endpoint = next();
    else if (arg === "--key-env") out.keyEnv = next();
    else if (arg === "--model") out.model = next();
    else if (arg === "--thinking") out.thinking = next();
    else if (arg === "--temperature") out.temperature = Number(next());
    else if (arg === "--max-tokens") out.maxTokens = Number(next());
    else if (arg === "--extra-json") out.extraJson = next();
    else if (arg === "--target-min-ratio") out.targetMinRatio = Number(next());
    else if (arg === "--target-mid-ratio") out.targetMidRatio = Number(next());
    else if (arg === "--target-max-ratio") out.targetMaxRatio = Number(next());
    else if (arg === "--var") {
      const pair = next();
      const eq = pair.indexOf("=");
      if (eq === -1) throw new Error(`--var expects key=value, got ${pair}`);
      out.vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else {
      throw new Error(`Unknown arg ${arg}`);
    }
  }
  return out;
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_m, key) => {
    const value = vars[key];
    return value === undefined ? "" : String(value);
  });
}

function withTargetVars(args, input) {
  const vars = { ...args.vars, ...input.vars, input: input.text };
  const inputTokens = Number(vars.projectedTokenCount);
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return vars;

  const minRatio = args.targetMinRatio;
  const midRatio = args.targetMidRatio;
  const maxRatio = args.targetMaxRatio;
  if (![minRatio, midRatio, maxRatio].every((value) => Number.isFinite(value) && value > 0)) return vars;

  return {
    ...vars,
    inputTokens,
    targetMinTokens: Math.ceil(inputTokens * minRatio),
    targetMidTokens: Math.round(inputTokens * midRatio),
    targetMaxTokens: Math.floor(inputTokens * maxRatio),
    targetMinRatio: minRatio,
    targetMidRatio: midRatio,
    targetMaxRatio: maxRatio,
  };
}

async function readInputs(args) {
  if (args.examples !== undefined) {
    const raw = await readFile(resolve(args.examples), "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line, index) => {
        const row = JSON.parse(line);
        if (typeof row.text !== "string") throw new Error(`examples row ${index + 1} missing text`);
        return {
          id: typeof row.id === "string" ? row.id : `row-${index + 1}`,
          text: row.text,
          vars: row.vars && typeof row.vars === "object" ? row.vars : {},
        };
      });
  }
  if (args.textFile !== undefined) {
    return [{ id: "single", text: await readFile(resolve(args.textFile), "utf8"), vars: {} }];
  }
  if (args.text !== undefined) return [{ id: "single", text: args.text, vars: {} }];
  throw new Error("Provide --text, --text-file, or --examples");
}

function endpointFor(args) {
  return args.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
}

function buildBody(args, systemPrompt, text) {
  const body = {
    model: args.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
  };
  if (args.temperature !== undefined) body.temperature = args.temperature;
  if (args.maxTokens !== undefined) body.max_tokens = args.maxTokens;
  if (args.thinking !== undefined) body.reasoning = { effort: args.thinking };
  if (args.extraJson !== undefined) Object.assign(body, JSON.parse(args.extraJson));
  return body;
}

function extractText(payload) {
  const choices = payload?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = first?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

async function callModel(args, body) {
  const key = process.env[args.keyEnv];
  if (key === undefined || key.trim() === "") {
    throw new Error(`Missing API key env ${args.keyEnv}`);
  }
  const endpoint = endpointFor(args);
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const requestStartedAt = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const headersReceivedAt = performance.now();
  const raw = await response.text();
  const bodyFinishedAt = performance.now();
  const headersMs = Math.round(headersReceivedAt - requestStartedAt);
  const bodyMs = Math.round(bodyFinishedAt - headersReceivedAt);
  const totalMs = Math.round(bodyFinishedAt - requestStartedAt);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }
  if (!response.ok) {
    return { ok: false, totalMs, headersMs, bodyMs, status: response.status, error: raw.slice(0, 2000), payload };
  }
  const text = extractText(payload);
  return {
    ok: text !== undefined,
    totalMs,
    headersMs,
    bodyMs,
    status: response.status,
    text,
    usage: payload?.usage,
    error: text === undefined ? "No assistant text in response" : undefined,
    payload,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (!args.prompt) throw new Error("Missing --prompt");
  if (!args.model) throw new Error("Missing --model");
  if (!args.out && !args.dryRun) throw new Error("Missing --out");

  const promptTemplate = await readFile(resolve(args.prompt), "utf8");
  const inputs = await readInputs(args);
  if (args.out) await mkdir(dirname(resolve(args.out)), { recursive: true });

  for (const input of inputs) {
    const vars = withTargetVars(args, input);
    const systemPrompt = fillTemplate(promptTemplate, vars);
    const body = buildBody(args, systemPrompt, input.text);
    const base = {
      timestamp: new Date().toISOString(),
      id: input.id,
      derivation: args.derivation,
      promptPath: args.prompt,
      provider: args.provider,
      endpoint: endpointFor(args),
      model: args.model,
      thinking: args.thinking,
      vars,
      inputChars: input.text.length,
    };

    if (args.dryRun) {
      console.log(JSON.stringify({ ...base, request: body }, null, 2));
      continue;
    }

    const result = await callModel(args, body);
    const outputChars = result.text?.length ?? 0;
    const compressionPct = input.text.length > 0 && result.ok ? Number(((outputChars / input.text.length) * 100).toFixed(1)) : undefined;
    const record = { ...base, ...result, outputChars, compressionPct };
    await appendFile(resolve(args.out), `${JSON.stringify(record)}\n`, "utf8");
    const summary = result.ok
      ? `OK ${input.id}: ${result.totalMs}ms, output ${outputChars} chars, ${compressionPct}% of input`
      : `FAIL ${input.id}: ${result.totalMs}ms, ${result.error ?? result.status}`;
    console.log(summary);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
