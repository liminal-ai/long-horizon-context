#!/usr/bin/env node
// Run case files through the codex CLI harness (one-shot exec, no session reuse).
// The CLI wraps our prompt in its own harness system prompt — deliberate: this is
// the CLI-harness provider lane, measured as it will actually be used.
// Usage: node turn-compression/run-codex-cli.mjs t2 t5 [--model gpt-5.3-codex-spark] [--effort low]
import { readFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../../../dist/index.js";

const cases = [];
const opts = { model: "gpt-5.3-codex-spark", effort: "low" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--model") opts.model = argv[++i];
  else if (a === "--effort") opts.effort = argv[++i];
  else cases.push(a.replace(/\.txt$/, ""));
}
if (cases.length === 0) { console.error("no cases given"); process.exit(1); }

const emptyDir = mkdtempSync(join(tmpdir(), "codex-lab-"));

for (const name of cases) {
  const raw = readFileSync(`turn-compression/cases/${name}.txt`, "utf8");
  const nl = raw.indexOf("\n");
  const meta = JSON.parse(raw.slice(0, nl));
  const afterMeta = raw.slice(nl + 1);
  const prompt = afterMeta.slice(afterMeta.indexOf("\n") + 1);
  const promptTokens = estimateTokens(prompt);

  const t0 = performance.now();
  const res = spawnSync("codex", [
    "exec", "--model", opts.model, "-c", `model_reasoning_effort="${opts.effort}"`,
    "--sandbox", "read-only", "--skip-git-repo-check", "--json", "-",
  ], { cwd: emptyDir, input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const elapsed = Math.round(performance.now() - t0);

  let text = "";
  let usage = null;
  let error = null;
  for (const line of (res.stdout ?? "").split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text ?? "";
    if (ev.type === "turn.completed") usage = ev.usage ?? null;
    if (ev.type === "error" || ev.type === "turn.failed") error = ev.message ?? ev.error ?? ev;
  }
  if (res.status !== 0 && !error) error = { exitCode: res.status, stderr: (res.stderr ?? "").slice(-300) };

  const outTok = estimateTokens(text);
  const ratio = Number((outTok / meta.inputTokens * 100).toFixed(1));
  const inWindow = outTok >= meta.min && outTok <= meta.max;
  const row = {
    case: name, run: 1, model: opts.model, effort: opts.effort, provider: "codex-cli", routedProvider: "chatgpt-oauth",
    promptTokens, inputTokens: meta.inputTokens, window: [meta.min, meta.max], aim: meta.aim,
    outputTokens: outTok, ratio, inWindow, finishReason: error ? "error" : "stop", nativeFinish: null,
    elapsed, usage, cost: null, error, output: text,
  };
  appendFileSync("turn-compression/results/runs.jsonl", JSON.stringify(row) + "\n");
  console.log(`${name} run 1 [${opts.model} ${opts.effort} codex-cli]: out=${outTok}t ratio=${ratio}% ${inWindow ? "IN-WINDOW" : "out"} ${elapsed}ms reasoning=${usage?.reasoning_output_tokens ?? "?"}t${error ? " ERROR " + JSON.stringify(error).slice(0, 120) : ""}`);
}
