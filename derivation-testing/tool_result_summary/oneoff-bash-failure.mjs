#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const rawOutput = `Updated packages
error: pi cannot self-update this installation.
This installation is not managed by a global npm install. Update it with the package manager, wrapper, or source checkout that provides it.

Location of pi executable: /Users/leemoore/code/pi-long-horizon/node_modules/.bin/pi


Command exited with code 1`;

function parseBashResult(output) {
  const exitCodeMatch = output.match(/Command exited with code (\d+)/);
  const executableMatch = output.match(/Location of pi executable:\s*(.+)/);
  const errorLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /^error:/i.test(line));
  const actionableLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0 &&
      !/^Updated packages$/i.test(line) &&
      !/^Command exited with code/i.test(line) &&
      !/^Location of pi executable:/i.test(line)
    );

  return {
    toolName: "bash",
    mechanicalOutcome: "failed",
    exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : null,
    executablePath: executableMatch?.[1]?.trim() ?? null,
    errorLines,
    actionableLines,
  };
}

const parsed = parseBashResult(rawOutput);

const prompt = `Summarize this bash tool response for long-horizon coding context.

Use the parsed mechanical fields as authoritative. Do not infer success or failure from the prose. Do not mention details that are not in the parsed fields or raw response.

Write one concise paragraph. Preserve:
- tool name
- failure status
- actionable reason
- executable path if present
- exit code if present

Parsed fields:
${JSON.stringify(parsed, null, 2)}

Raw response:
\`\`\`text
${rawOutput}
\`\`\`

Return only the summary paragraph.`;

const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is not set");

const model = process.argv[2] ?? "openai/gpt-5.4-mini";
const extraJson = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const body = {
  model,
  messages: [
    { role: "system", content: "You summarize tool responses for a coding agent memory system." },
    { role: "user", content: prompt },
  ],
  temperature: 0.1,
  reasoning: { enabled: false },
  ...extraJson,
};

const started = performance.now();
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
const raw = await response.text();
const totalMs = Math.round(performance.now() - started);
if (!response.ok) {
  console.log("status", response.status);
  console.log(raw.slice(0, 2000));
  process.exit(1);
}
const payload = JSON.parse(raw);
const text = payload.choices?.[0]?.message?.content ?? "";
console.log("PARSED_FIELDS");
console.log(JSON.stringify(parsed, null, 2));
console.log("\nSUMMARY");
console.log(text.trim());
console.log("\nMETRICS");
console.log(JSON.stringify({ totalMs, usage: payload.usage }, null, 2));
