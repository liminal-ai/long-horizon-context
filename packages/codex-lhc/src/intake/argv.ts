const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidToken(value: string): boolean {
  return UUID_RE.test(value);
}

/** Advance past one argv flag token and its value when present. */
function skipFlag(argv: readonly string[], index: number): number {
  const arg = argv[index];
  if (arg === undefined || !arg.startsWith("-")) return index + 1;
  if (arg === "--") return index + 1;

  if (arg.startsWith("--config=")) return index + 1;
  if (arg.startsWith("-c") && arg.length > 2) return index + 1;
  if (arg.startsWith("--") && arg.includes("=")) return index + 1;

  if (arg.startsWith("-") && !arg.startsWith("--") && arg.length === 2) {
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) return index + 2;
    return index + 1;
  }

  if (arg === "-c" || arg === "--config" || arg.startsWith("--")) {
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) return index + 2;
  }

  return index + 1;
}

export type CodexResumeIntent =
  | { kind: "resume-id"; sessionId: string }
  | { kind: "resume-last" }
  | { kind: "none" };

function parseAfterResume(argv: readonly string[], start: number): CodexResumeIntent {
  let index = start;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === "--last") return { kind: "resume-last" };
    if (arg.startsWith("-")) {
      index = skipFlag(argv, index);
      continue;
    }
    if (isUuidToken(arg)) return { kind: "resume-id", sessionId: arg };
    return { kind: "none" };
  }
  return { kind: "none" };
}

function findResumeTokenIndex(argv: readonly string[]): number | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "resume") return index;
    if (arg.startsWith("-")) {
      index = skipFlag(argv, index) - 1;
      continue;
    }
    if (arg !== "exec") continue;

    let scan = index + 1;
    while (scan < argv.length) {
      const token = argv[scan]!;
      if (token.startsWith("-")) {
        scan = skipFlag(argv, scan);
        continue;
      }
      if (token === "resume") return scan;
      break;
    }
  }
  return undefined;
}

/** Parse codex child argv for resume intent, tolerant of interspersed flags. */
export function parseCodexResumeIntent(argv: readonly string[]): CodexResumeIntent {
  const resumeIndex = findResumeTokenIndex(argv);
  if (resumeIndex === undefined) return { kind: "none" };
  return parseAfterResume(argv, resumeIndex + 1);
}

export function resumeSessionIdFromIntent(intent: CodexResumeIntent): string | undefined {
  return intent.kind === "resume-id" ? intent.sessionId : undefined;
}

export function hasResumeLastIntent(intent: CodexResumeIntent): boolean {
  return intent.kind === "resume-last";
}
