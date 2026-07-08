export function resolveClaudeBin(): string {
  return process.env.CODEX_LHC_CLAUDE_BIN ?? "claude";
}
