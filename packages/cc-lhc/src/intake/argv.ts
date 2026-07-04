function isArgvFlagToken(arg: string): boolean {
  return arg.startsWith("-");
}

/** Parse `--resume <sessionId>` or `--resume=<sessionId>` from the child argv passed to Claude Code. */
export function parseResumeSessionId(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length);
      return value !== "" ? value : undefined;
    }
    if (arg === "--resume") {
      if (index + 1 >= argv.length) return undefined;
      const next = argv[index + 1]!;
      if (isArgvFlagToken(next)) return undefined;
      return next !== "" ? next : undefined;
    }
  }
  return undefined;
}

export function hasContinueFlag(argv: readonly string[]): boolean {
  return argv.includes("--continue");
}
