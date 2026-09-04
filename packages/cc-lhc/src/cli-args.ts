/**
 * Wrapper argv parsing (D13). Every --lhc-* flag before the first standalone
 * `--` belongs to cc-lhc; the `--` and every later token pass to Claude
 * unchanged, including tokens that look like --lhc-*. Pure so the real
 * production parser is directly testable.
 */

import type { ContextPolicyPartial } from "./governor/index.js";

export interface ParsedWrapperArgv {
  /** Argv forwarded to Claude, including the `--` boundary when present. */
  claudeArgv: string[];
  noInference: boolean;
  notifierDisabled: boolean;
  contextPolicyOverrides: ContextPolicyPartial;
}

export type WrapperArgvResult = { ok: true; parsed: ParsedWrapperArgv } | { ok: false; message: string };

export function parseWrapperArgv(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): WrapperArgvResult {
  const out: string[] = [];
  let noInference = env.CC_LHC_NO_INFERENCE === "1";
  let notifierDisabled = false;
  const contextPolicyOverrides: ContextPolicyPartial = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      // Claude keeps its own end-of-options semantics for the same boundary.
      out.push(...argv.slice(i));
      break;
    }
    if (arg.startsWith("--lhc-")) {
      if (arg === "--lhc-no-inference") {
        noInference = true;
        continue;
      }
      // Session overrides for context policy, applied after project config.
      const upper = arg.match(/^--lhc-upper-bound-tokens=(\d+)$/);
      if (upper) {
        contextPolicyOverrides.upperBoundTokens = Number(upper[1]);
        continue;
      }
      const lower = arg.match(/^--lhc-lower-bound-tokens=(\d+)$/);
      if (lower) {
        contextPolicyOverrides.lowerBoundTokens = Number(lower[1]);
        continue;
      }
      const profile = arg.match(/^--lhc-profile=(.+)$/);
      if (profile?.[1]) {
        contextPolicyOverrides.profile = profile[1];
        continue;
      }
      const runway = arg.match(/^--lhc-min-runway-tokens=(\d+)$/);
      if (runway) {
        contextPolicyOverrides.minRunwayTokens = Number(runway[1]);
        continue;
      }
      if (arg === "--lhc-no-notifier") {
        notifierDisabled = true;
        continue;
      }
      return {
        ok: false,
        message: `Unknown cc-lhc flag: ${arg} (cc-lhc owns the --lhc-* namespace before --)`,
      };
    }
    out.push(arg);
  }
  return {
    ok: true,
    parsed: { claudeArgv: out, noInference, notifierDisabled, contextPolicyOverrides },
  };
}

/** Exact single-argument form, like --lhc-help: never launches Claude. */
export function isLhcVersionArgv(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === "--lhc-version";
}
