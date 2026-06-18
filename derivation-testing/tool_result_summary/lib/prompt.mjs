const MODE_GUIDANCE = {
  receipt: `Write a concise tool-result receipt. Preserve status, concrete paths, counts, identifiers, and retry guidance. For write/edit receipts, do not infer changed content. If mutationDetailsAvailable is false, say the content/edit details were not available in the response when that matters. Do not quote the raw response.`,
  failure: `Write a concise failure receipt. Preserve what failed, why, the target path or command, exit code, and actionable retry guidance. Do not generalize away the concrete error.`,
  search_summary: `Summarize the search/listing result. Preserve query/command if present, match or no-match status, relevant paths, counts, and key locations. Do not list every match unless the output is already small.`,
  test_summary: `Write a compact verification receipt. Preserve command, final status, exit code, pass/fail counts, failed test names, and the core assertion/error reason. Prefer parsed testSummary over raw log detail. Do not list stack frames or every path. Keep it short unless multiple distinct failures need naming.`,
  content_summary: `Summarize what the file/output contains that matters for future work. Preserve file path, major sections/exports/config, and important values. Do not restate full contents.`,
  diff_summary: `Summarize changed files and nature of changes. Preserve insertion/deletion scale if available. Do not reproduce full diff.`,
  large_log: `Extract the final status, key errors, paths, counts, and next actionable facts. Drop repeated boilerplate and long logs.`,
  no_output: `Write a concise receipt for a successful command that produced no output. Preserve the command and explain that no output means a clean/no-change result only if the parsed outcome says succeeded.`,
  multi_tool_summary: `Summarize each subtool result separately. Preserve which subcalls succeeded or failed, missing paths/errors, and no-output clean statuses. Do not collapse mixed success/failure into one vague result.`,
  generic_summary: `Summarize the tool result for future coding context. Preserve concrete facts and avoid inventing missing details.`, 
};

export function buildPrompt({ fixture, classification }) {
  const targetTokens = fixture.targetTokens;
  const guidance = MODE_GUIDANCE[classification.promptMode] ?? MODE_GUIDANCE.generic_summary;
  const promptFacts = factsForPrompt(classification.facts);
  const rawForPrompt = rawOutputForPrompt(fixture.rawOutput, classification);
  return `Summarize this tool response for long-horizon coding context.

Use the parsed fields as authoritative facts. Do not infer success or failure from prose. Do not mention details that are not in the parsed fields or raw response.

Use parsed field values, but do not mention parsed field labels such as failureType, failedField, retryGuidance, matchCount, targetPath, responseShape, operationClass, mutationDetailsAvailable, searchNoMatches, noOutput, subtoolResults, or testSummary. Preserve paths, commands, identifiers, counts, and exit codes verbatim. Do not quote or label the raw response. Do not add diagnostic conclusions, root-cause analysis, or recommended code changes beyond what the parsed fields or raw response directly support.

Target length: about ${targetTokens} tokens.
Prompt mode: ${classification.promptMode}

Mode guidance:
${guidance}

Parsed fields:
${JSON.stringify(promptFacts, null, 2)}

Raw tool response excerpt:
\`\`\`text
${rawForPrompt}
\`\`\`

Return only the summary.`;
}

function factsForPrompt(facts) {
  const excluded = new Set(["operationClass", "responseShape", "outputChars", "outputWords"]);
  return Object.fromEntries(Object.entries(facts).filter(([key]) => !excluded.has(key)));
}

function rawOutputForPrompt(rawOutput, classification) {
  const lines = rawOutput.split(/\r?\n/);
  if (classification.responseShape === "search_result" && lines.length > 60) {
    return [
      ...lines.slice(0, 60),
      "",
      `[omitted ${lines.length - 60} additional search-result lines; use parsed searchMatchCount/searchMatches as authoritative]`,
    ].join("\n");
  }
  if (rawOutput.length > 20000) {
    const head = rawOutput.slice(0, 12000);
    const tail = rawOutput.slice(-4000);
    return `${head}\n\n[omitted ${rawOutput.length - head.length - tail.length} middle characters]\n\n${tail}`;
  }
  return rawOutput;
}
