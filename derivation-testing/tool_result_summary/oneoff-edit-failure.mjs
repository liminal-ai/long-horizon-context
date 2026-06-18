#!/usr/bin/env node
import { performance } from "node:perf_hooks";

const rawOutput = `Found 2 occurrences of edits[0] in tests/thread/lower-band-compression-service.test.ts. Each oldText must be unique. Please provide more context to make it unique.`;

function parseEditResult(output) {
  const occurrenceMatch = output.match(/Found\s+(\d+)\s+occurrences\s+of\s+([^\s]+)\s+in\s+([^\.]+(?:\.[A-Za-z0-9_-]+)+)/i);
  const uniqueFieldMatch = output.match(/Each\s+([^\s]+)\s+must be unique/i);
  const contextFix = /provide more context/i.test(output);

  const targetExpression = occurrenceMatch?.[2] ?? null;
  const uniqueField = uniqueFieldMatch?.[1] ?? null;
  const failedField = targetExpression && uniqueField ? `${targetExpression}.${uniqueField}` : targetExpression;
  const matchCount = occurrenceMatch ? Number(occurrenceMatch[1]) : null;

  return {
    toolName: "edit",
    outcome: "failed",
    operationClass: "edit",
    failureType: matchCount && matchCount > 1 ? "non_unique_old_text" : "unknown_edit_failure",
    targetPath: occurrenceMatch?.[3] ?? null,
    failedField,
    matchCount,
    requiredCondition: uniqueField ? `${uniqueField} must match exactly one location` : null,
    retryGuidance: contextFix ? "retry with more surrounding context so the replacement target is unique" : null,
  };
}

const parsed = parseEditResult(rawOutput);

const prompt = `Summarize this edit tool response for long-horizon coding context.

Use the parsed fields as authoritative facts. Do not infer success or failure from prose. Do not mention details that are not in the parsed fields or raw response.

Write one concise tool-result receipt. Use parsed field values, but do not mention parsed field labels such as failureType, failedField, retryGuidance, matchCount, or targetPath. Preserve paths and identifiers verbatim.

Required content:
- tool name
- failed outcome
- path value
- failed field value, if present
- match count, if present
- retry guidance, if present

Avoid vague summaries like "the edit failed due to ambiguity." Be specific.

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
const extraJson = process.argv[3] ? JSON.parse(process.argv[3]) : { provider: { only: ["openai"], allow_fallbacks: false } };

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
