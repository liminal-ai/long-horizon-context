#!/usr/bin/env node
import type { ContextPolicyPartial } from "./governor/index.js";
import { isRetrievalArgv, runRetrievalCli } from "./retrieval/service.js";
import { run } from "./wrapper/run.js";

function stripCcLhcFlags(argv: string[]): {
  argv: string[];
  noCapture: boolean;
  noInference: boolean;
  contextPolicyOverrides: ContextPolicyPartial;
} {
  const out: string[] = [];
  let noCapture = false;
  let noInference = process.env.CC_LHC_NO_INFERENCE === "1";
  const contextPolicyOverrides: ContextPolicyPartial = {};
  for (const arg of argv) {
    // Contract: every --lhc-* flag belongs to cc-lhc and is consumed here;
    // everything else passes through to claude verbatim.
    if (arg.startsWith("--lhc-")) {
      if (arg === "--lhc-no-capture") {
        noCapture = true;
        continue;
      }
      if (arg === "--lhc-no-inference") {
        noInference = true;
        continue;
      }
      // Session overrides for context policy (Slice 3 observe-only).
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
      const auto = arg.match(/^--lhc-auto-compact=(on|off)$/);
      if (auto) {
        contextPolicyOverrides.autoCompact = auto[1] === "on";
        continue;
      }
      const profile = arg.match(/^--lhc-profile=(.+)$/);
      if (profile?.[1]) {
        contextPolicyOverrides.profile = profile[1];
        continue;
      }
      const growth = arg.match(/^--lhc-retry-growth-tokens=(\d+)$/);
      if (growth) {
        contextPolicyOverrides.retryGrowthTokens = Number(growth[1]);
        continue;
      }
      const runway = arg.match(/^--lhc-min-runway-tokens=(\d+)$/);
      if (runway) {
        contextPolicyOverrides.minRunwayTokens = Number(runway[1]);
        continue;
      }
      console.error(`Unknown cc-lhc flag: ${arg} (cc-lhc owns the --lhc-* namespace)`);
      process.exit(2);
    }
    out.push(arg);
  }
  return { argv: out, noCapture, noInference, contextPolicyOverrides };
}

const rawArgv = process.argv.slice(2);

// Model-callable retrieval ops: bound descriptor selects the archive.
// These never open the PTY wrapper. Do not process.exit here — set exitCode
// so Node can drain stdout after the awaited flush-safe write.
if (isRetrievalArgv(rawArgv)) {
  const exitCode = await runRetrievalCli(rawArgv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  });
  process.exitCode = exitCode;
} else {
  const parsed = stripCcLhcFlags(rawArgv);
  const hasOverrides = Object.keys(parsed.contextPolicyOverrides).length > 0;

  const exitCode = await run(parsed.argv, {
    noCapture: parsed.noCapture,
    noInference: parsed.noInference,
    ...(hasOverrides ? { contextPolicyOverrides: parsed.contextPolicyOverrides } : {}),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  });

  // Wrapper path may need force-exit for PTY lifecycle; retrieval does not.
  process.exit(exitCode);
}
