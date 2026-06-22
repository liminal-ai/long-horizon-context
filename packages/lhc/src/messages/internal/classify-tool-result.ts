import type {
  ToolOutcome,
  ToolResultClassification,
  ToolResultOperationClass,
  ToolResultPromptMode,
  ToolResultResponseShape,
} from "../../shared-tech/index.js";

export interface ToolResultClassificationInput {
  toolName: string;
  toolInput?: Record<string, unknown>;
  outcome: ToolOutcome;
  rawOutput: string;
}

export function classifyToolResult(input: ToolResultClassificationInput): ToolResultClassification {
  const operationClass = classifyOperation(input.toolName, input.toolInput, input.rawOutput);
  const responseShape = classifyShape(input.toolName, input.outcome, input.rawOutput, operationClass);
  const promptMode = promptModeFor(responseShape, input.outcome);
  const facts = parseFacts({ ...input, operationClass, responseShape });

  return {
    operationClass,
    responseShape,
    promptMode,
    facts,
  };
}

function commandOf(toolInput: Record<string, unknown> | undefined): string {
  return typeof toolInput?.["command"] === "string" ? toolInput["command"] : "";
}

function classifyOperation(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  rawOutput: string,
): ToolResultOperationClass {
  if (toolName === "read") return "read";
  if (toolName === "write") return "mutation_write";
  if (toolName === "edit") return "mutation_edit";
  if (toolName === "multi_tool_use.parallel") return "multi_tool";
  if (toolName === "bash") {
    const command = commandOf(toolInput);
    if (/\b(rg|grep|find)\b/.test(command)) return "search_or_listing";
    if (/\b(vitest|tsx --test|node --test|npm test|pnpm test|pnpm run verify|tsc|typecheck|lint)\b/.test(command)) {
      return "verification";
    }
    if (/\b(git diff|git status|git show|git log)\b/.test(command)) return "vcs_inspection";
    if (/\b(rm|mv|cp|mkdir|chmod|touch)\b/.test(command)) return "filesystem_mutation";
    if (/\b(diff --git|Test Files|Tests\s+\d|Command exited with code)\b|[\u2714\u2716]/.test(rawOutput)) {
      return "command";
    }
    return "command";
  }
  return "unknown";
}

function classifyShape(
  toolName: string,
  outcome: ToolOutcome,
  rawOutput: string,
  operationClass: ToolResultOperationClass,
): ToolResultResponseShape {
  const output = rawOutput.trim();
  if (operationClass === "multi_tool") return "multi_tool_result";
  if (output === "(no output)" || output === "") return "no_output";
  if (operationClass === "search_or_listing" && isSearchNoMatchOutput(output)) return "search_result";
  if (isStructuredReceiptOutput(output)) return "structured_receipt";
  if (/^Found\s+\d+\s+occurrences\s+of\s+.+?\s+in\s+.+?\./i.test(output)) return "structured_receipt";
  if (/\bENOENT\b|No such file or directory|command not found|invalid option|Cannot find package/i.test(output)) {
    return "simple_failure";
  }
  if (
    operationClass === "verification" &&
    (/\b(Test Files|Tests|failed|passed|vitest|tsc --noEmit|typecheck|lint|CACError|AssertionError|TAP version|# tests)\b/i.test(
      output,
    ) ||
      /[\u2714\u2716]/.test(output))
  ) {
    return "test_result";
  }
  if (looksLikeTestRunnerOutput(output)) return "test_result";
  if (/Command exited with code\s+(?!0\b)\d+/i.test(output) && output.length < 1200) return "simple_failure";
  if (
    /^diff --git\b/m.test(output) ||
    /\|\s+\d+\s+[+-]+/m.test(output) ||
    /files? changed,\s+\d+ insertions?/i.test(output)
  ) {
    return "diff_output";
  }
  if (
    operationClass === "search_or_listing" &&
    (/^\d+:/m.test(output) || /^[^\n:]+:\d+:/m.test(output) || output.length > 0)
  ) {
    return "search_result";
  }
  if (/^[^\n:]+:\d+:/m.test(output) || /^\S+\s+\d+\s*$/m.test(output)) return "search_result";
  if (toolName === "read" && outcome !== "failed") return output.length > 5000 ? "large_file_content" : "file_content";
  if (output.length > 5000) return "large_log";
  return "unknown_content";
}

function promptModeFor(responseShape: ToolResultResponseShape, outcome: ToolOutcome): ToolResultPromptMode {
  if (responseShape === "structured_receipt") return "receipt";
  if (responseShape === "no_output") return "no_output";
  if (responseShape === "multi_tool_result") return "multi_tool_summary";
  if (responseShape === "simple_failure") return "failure";
  if (responseShape === "search_result") return "search_summary";
  if (responseShape === "test_result") return "test_summary";
  if (responseShape === "diff_output") return "diff_summary";
  if (responseShape === "file_content" || responseShape === "large_file_content") return "content_summary";
  if (responseShape === "large_log") return "large_log";
  if (outcome === "failed") return "failure";
  return "generic_summary";
}

function parseFacts(
  input: ToolResultClassificationInput & {
    operationClass: ToolResultOperationClass;
    responseShape: ToolResultResponseShape;
  },
): Record<string, unknown> {
  const rawOutput = input.rawOutput;
  return removeNullish({
    toolName: input.toolName,
    outcome: input.outcome,
    operationClass: input.operationClass,
    responseShape: input.responseShape,
    failureType: parseFailureType(rawOutput),
    command: commandOf(input.toolInput) || null,
    exitCode: parseExitCode(rawOutput),
    targetPath: parsePrimaryPath(rawOutput),
    byteCount: parseByteCount(rawOutput),
    blockCount: parseBlockCount(rawOutput),
    mutationDetailsAvailable: parseMutationDetailsAvailable(input.toolName, rawOutput),
    failedField: parseFailedField(rawOutput),
    matchCount: parseMatchCount(rawOutput),
    requiredCondition: parseRequiredCondition(rawOutput),
    retryGuidance: parseRetryGuidance(rawOutput),
    missingCommand: parseMissingCommand(rawOutput),
    systemError: parseSystemError(rawOutput),
    noOutput: rawOutput.trim() === "(no output)" || rawOutput.trim() === "",
    searchNoMatches:
      input.operationClass === "search_or_listing" && input.responseShape === "search_result"
        ? isSearchNoMatchOutput(rawOutput.trim())
        : null,
    searchMatchCount:
      input.operationClass === "search_or_listing" && input.responseShape === "search_result"
        ? parseSearchMatchCount(input.operationClass, rawOutput)
        : null,
    searchMatches:
      input.operationClass === "search_or_listing" && input.responseShape === "search_result"
        ? parseSearchMatches(input.operationClass, rawOutput).slice(0, 12)
        : [],
    testSummary: parseTestSummary(input.operationClass, rawOutput),
    subtoolResults: parseSubtoolResults(input.operationClass, rawOutput),
    pathMentions: parsePathMentions(rawOutput).slice(0, 12),
    outputChars: rawOutput.length,
    outputWords: rawOutput.split(/\s+/).filter(Boolean).length,
  });
}

function looksLikeTestRunnerOutput(output: string): boolean {
  return /\bTAP version\b/i.test(output) && /#\s*tests\s+\d+/i.test(output);
}

function isStructuredReceiptOutput(output: string): boolean {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(
    (line) =>
      /^Successfully wrote\s+\d+\s+bytes to\s+.+\.?$/i.test(line) ||
      /^Successfully replaced\s+\d+\s+block\(s\) in\s+.+\.?$/i.test(line) ||
      /^Found\s+\d+\s+occurrences\s+of\s+.+?\s+in\s+.+?\./i.test(line),
  );
}

function isSearchNoMatchOutput(output: string): boolean {
  const contentLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Command exited with code\s+1$/i.test(line));
  return contentLines.length === 0 && /Command exited with code\s+1/i.test(output);
}

function searchContentLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Command exited with code\s+\d+$/i.test(line));
}

function parseSearchMatchCount(operationClass: ToolResultOperationClass, output: string): number | null {
  if (operationClass !== "search_or_listing") return null;
  if (isSearchNoMatchOutput(output.trim())) return 0;
  const lines = searchContentLines(output);
  return lines.length || null;
}

function parseSearchMatches(operationClass: ToolResultOperationClass, output: string): Record<string, unknown>[] {
  if (operationClass !== "search_or_listing") return [];
  return searchContentLines(output).map((line) => {
    let match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (match !== null) return { path: match[1], line: Number(match[2]), text: match[3]?.trim() ?? "" };
    match = line.match(/^(\d+):(.*)$/);
    if (match !== null) return { line: Number(match[1]), text: match[2]?.trim() ?? "" };
    return { text: line };
  });
}

function parseTestSummary(operationClass: ToolResultOperationClass, output: string): Record<string, unknown> | null {
  if (operationClass !== "verification") return null;
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary: Record<string, unknown> = {};
  const testsLine = lines.find((line) => /\btests?\b/i.test(line) && /\bpass(?:ed)?\b/i.test(line));
  const totalMatch = output.match(/(?:#\s*)?(\d+)\s+tests?\b/i) ?? output.match(/#\s*tests\s+(\d+)/i);
  const passedMatch = output.match(/(?:#\s*)?(\d+)\s+pass(?:ed)?\b/i) ?? output.match(/#\s*pass\s+(\d+)/i);
  const failedMatch = output.match(/(?:#\s*)?(\d+)\s+fail(?:ed)?\b/i) ?? output.match(/#\s*fail\s+(\d+)/i);
  if (totalMatch?.[1] !== undefined) summary["total"] = Number(totalMatch[1]);
  if (passedMatch?.[1] !== undefined) summary["passed"] = Number(passedMatch[1]);
  if (failedMatch?.[1] !== undefined) summary["failed"] = Number(failedMatch[1]);
  if (testsLine !== undefined) summary["countLine"] = testsLine;

  const failedTests: string[] = [];
  for (const line of lines) {
    const match = line.match(/[\u2716xX]\s+(.+?)(?:\s+\(|$)/);
    if (match?.[1] !== undefined) {
      const name = match[1].trim();
      if (!/^failing tests:?$/i.test(name)) failedTests.push(name);
    }
  }
  const uniqueFailedTests = [...new Set(failedTests)];
  if (uniqueFailedTests.length > 0) summary["failedTests"] = uniqueFailedTests.slice(0, 8);
  if (summary["failed"] === undefined && uniqueFailedTests.length > 0) summary["failed"] = uniqueFailedTests.length;
  if (summary["passed"] === undefined) {
    const passMarkers = lines.filter((line) => /^[\u2714vV]\s+/.test(line)).length;
    if (passMarkers > 0) summary["passed"] = passMarkers;
  }
  if (summary["total"] === undefined && summary["passed"] !== undefined && summary["failed"] !== undefined) {
    summary["total"] = Number(summary["passed"]) + Number(summary["failed"]);
  }

  const assertionLines = lines.filter((line) =>
    /AssertionError|Expected values|strictly deep-equal|actual|expected/i.test(line),
  );
  if (assertionLines.length > 0) summary["assertionLines"] = assertionLines.slice(0, 8);

  const commandFailure = output.match(/Command exited with code\s+(\d+)/i);
  if (commandFailure?.[1] !== undefined) summary["exitCode"] = Number(commandFailure[1]);
  return Object.keys(summary).length > 0 ? summary : null;
}

function parseSubtoolResults(
  operationClass: ToolResultOperationClass,
  output: string,
): Record<string, unknown>[] | null {
  if (operationClass !== "multi_tool") return null;
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^:]+):\s*(succeeded|failed)(?:,\s*(.*))?$/i);
      if (match === null) return { text: line };
      return removeNullish({
        label: match[1],
        outcome: match[2]?.toLowerCase(),
        detail: match[3] ?? null,
      });
    });
}

function parseExitCode(output: string): number | null {
  const match = output.match(/Command exited with code\s+(\d+)/i);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

function parseByteCount(output: string): number | null {
  const match = output.match(/Successfully wrote\s+(\d+)\s+bytes/i);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

function parseBlockCount(output: string): number | null {
  const match = output.match(/Successfully replaced\s+(\d+)\s+block\(s\)/i);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

function parseMatchCount(output: string): number | null {
  const match = output.match(/Found\s+(\d+)\s+occurrences/i);
  return match?.[1] !== undefined ? Number(match[1]) : null;
}

function parseMutationDetailsAvailable(toolName: string, output: string): boolean | null {
  if (toolName !== "write" && toolName !== "edit") return null;
  if (/^Successfully wrote\s+\d+\s+bytes to\s+.+\.?$/i.test(output.trim())) return false;
  if (/^Successfully replaced\s+\d+\s+block\(s\) in\s+.+\.?$/i.test(output.trim())) return false;
  return null;
}

function parseFailedField(output: string): string | null {
  const occurrenceMatch = output.match(
    /Found\s+\d+\s+occurrences\s+of\s+([^\s]+)\s+in\s+([^.]*(?:\.[A-Za-z0-9_-]+)+)/i,
  );
  const uniqueFieldMatch = output.match(/Each\s+([^\s]+)\s+must be unique/i);
  if (occurrenceMatch?.[1] === undefined) return null;
  return uniqueFieldMatch?.[1] !== undefined ? `${occurrenceMatch[1]}.${uniqueFieldMatch[1]}` : occurrenceMatch[1];
}

function parseRequiredCondition(output: string): string | null {
  const uniqueFieldMatch = output.match(/Each\s+([^\s]+)\s+must be unique/i);
  return uniqueFieldMatch?.[1] !== undefined ? `${uniqueFieldMatch[1]} must match exactly one location` : null;
}

function parseRetryGuidance(output: string): string | null {
  if (/provide more context/i.test(output))
    return "retry with more surrounding context so the replacement target is unique";
  if (/command not found/i.test(output)) return "install the command or invoke it through the project package runner";
  if (/No such file or directory|ENOENT/i.test(output))
    return "check the path or run from the expected working directory";
  return null;
}

function parseMissingCommand(output: string): string | null {
  const shellMatch = output.match(/(?:sh|bash|zsh):\s*([^:\s]+):\s*command not found/i);
  return shellMatch?.[1] ?? null;
}

function parseSystemError(output: string): string | null {
  const match = output.match(/\b(ENOENT|EACCES|EPERM|EEXIST|ENOTDIR|EISDIR)\b/);
  return match?.[1] ?? null;
}

function parseFailureType(output: string): string | null {
  if (/Found\s+\d+\s+occurrences/i.test(output)) return "non_unique_old_text";
  if (/command not found/i.test(output)) return "command_not_found";
  if (/No such file or directory|ENOENT/i.test(output)) return "missing_path";
  if (/invalid option/i.test(output)) return "invalid_option";
  if (/Cannot find package/i.test(output)) return "missing_package";
  if (/Command exited with code\s+(?!0\b)\d+/i.test(output)) return "nonzero_exit";
  return null;
}

function parsePrimaryPath(output: string): string | null {
  const writeMatch = output.match(/Successfully wrote\s+\d+\s+bytes to\s+(.+?)\.?$/i);
  if (writeMatch?.[1] !== undefined) return trimPath(writeMatch[1]);
  const editMatch = output.match(/Successfully replaced\s+\d+\s+block\(s\) in\s+(.+?)\.?$/i);
  if (editMatch?.[1] !== undefined) return trimPath(editMatch[1]);
  const occurrenceMatch = output.match(/Found\s+\d+\s+occurrences\s+of\s+[^\s]+\s+in\s+(.+?)\./i);
  if (occurrenceMatch?.[1] !== undefined) return trimPath(occurrenceMatch[1]);
  const accessMatch = output.match(/access ['"]([^'"]+)['"]/i);
  if (accessMatch?.[1] !== undefined) return accessMatch[1];
  const findMatch = output.match(/find:\s+([^:]+):\s+No such file or directory/i);
  if (findMatch?.[1] !== undefined) return trimPath(findMatch[1]);
  const locationMatch = output.match(/Location of .*?:\s*(.+)/i);
  if (locationMatch?.[1] !== undefined) return trimPath(locationMatch[1]);
  return null;
}

function parsePathMentions(output: string): string[] {
  const matches = output.match(/(?:\.?\.?\/|\/Users\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@-]+/g) ?? [];
  return [...new Set(matches.map(trimPath))];
}

function trimPath(value: string): string {
  return String(value)
    .trim()
    .replace(/[.,;:]+$/, "");
}

function removeNullish<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)),
  );
}
