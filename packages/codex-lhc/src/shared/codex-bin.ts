export function resolveCodexBin(): string {
  return process.env.CODEX_LHC_CODEX_BIN ?? "codex";
}
