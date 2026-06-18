export function parseFixtureRecord(record) {
  const vars = record.vars ?? {};
  const text = String(record.text ?? "");
  const rawOutput = extractToolResult(text) ?? text;
  const toolInput = extractToolInput(text);
  const toolName = vars.toolName || inferToolName(text) || "unknown_tool";
  const outcome = vars.outcome || inferOutcome(rawOutput);
  const targetTokens = Number(vars.targetTokens ?? 100);

  return {
    id: String(record.id ?? "unknown"),
    text,
    rawOutput,
    toolInput,
    toolName,
    outcome,
    targetTokens: Number.isFinite(targetTokens) ? targetTokens : 100,
    vars,
  };
}

function extractToolResult(text) {
  const match = text.match(/Tool result:\s*```(?:text)?\s*\n([\s\S]*?)\n```/i);
  return match?.[1] ?? null;
}

function extractToolInput(text) {
  const match = text.match(/Tool input:\s*```json\s*\n([\s\S]*?)\n```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1];
  }
}

function inferToolName(text) {
  const match = text.match(/Tool:\s*([A-Za-z0-9_.-]+)/i);
  return match?.[1] ?? null;
}

function inferOutcome(rawOutput) {
  if (/Command exited with code\s+(?!0\b)\d+/i.test(rawOutput)) return "failed";
  if (/\bENOENT\b|No such file or directory|command not found|invalid option/i.test(rawOutput)) return "failed";
  if (/Successfully wrote|Successfully replaced/i.test(rawOutput)) return "succeeded";
  return "unknown";
}
