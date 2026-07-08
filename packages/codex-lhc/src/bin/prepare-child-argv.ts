export const AUTO_COMPACT_FLAG = "model_auto_compact_token_limit";
export const AUTO_COMPACT_SUPPRESSION_VALUE = "100000000";

function configTokenNamesAutoCompactKey(token: string): boolean {
  if (token === AUTO_COMPACT_FLAG || token.startsWith(`${AUTO_COMPACT_FLAG}=`)) return true;
  if (token.startsWith("-c") && token.length > 2) {
    const rest = token.slice(2);
    return rest === AUTO_COMPACT_FLAG || rest.startsWith(`${AUTO_COMPACT_FLAG}=`);
  }
  if (token.startsWith("--config=")) {
    const rest = token.slice("--config=".length);
    return rest === AUTO_COMPACT_FLAG || rest.startsWith(`${AUTO_COMPACT_FLAG}=`);
  }
  return false;
}

/** True when argv already sets `model_auto_compact_token_limit` in any codex/clap config form. */
export function argvHasAutoCompactOverride(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (configTokenNamesAutoCompactKey(arg)) return true;
    if (arg === "-c" || arg === "--config") {
      const next = argv[index + 1];
      if (next !== undefined && configTokenNamesAutoCompactKey(next)) return true;
    }
  }
  return false;
}

export function stripCodexLhcFlags(argv: string[]): {
  argv: string[];
  noCapture: boolean;
  noInference: boolean;
  suppressAutoCompact: boolean;
} {
  const out: string[] = [];
  let noCapture = false;
  let noInference = process.env.CODEX_LHC_NO_INFERENCE === "1";
  let suppressAutoCompact = true;
  for (const arg of argv) {
    if (arg === "--no-capture") {
      noCapture = true;
      continue;
    }
    if (arg === "--no-inference") {
      noInference = true;
      continue;
    }
    if (arg === "--no-autocompact-suppression") {
      suppressAutoCompact = false;
      continue;
    }
    out.push(arg);
  }
  return { argv: out, noCapture, noInference, suppressAutoCompact };
}

export function injectAutoCompactSuppression(argv: readonly string[]): string[] {
  return [...argv, "-c", `${AUTO_COMPACT_FLAG}=${AUTO_COMPACT_SUPPRESSION_VALUE}`];
}

export function prepareChildArgv(argv: string[]): {
  argv: string[];
  noCapture: boolean;
  noInference: boolean;
} {
  const stripped = stripCodexLhcFlags(argv);
  const childArgv =
    stripped.suppressAutoCompact && !argvHasAutoCompactOverride(stripped.argv)
      ? injectAutoCompactSuppression(stripped.argv)
      : stripped.argv;
  return {
    argv: childArgv,
    noCapture: stripped.noCapture,
    noInference: stripped.noInference,
  };
}
