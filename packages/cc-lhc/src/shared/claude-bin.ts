export function resolveClaudeBin(): string {
  return process.env.CC_LHC_CLAUDE_BIN ?? "claude";
}
