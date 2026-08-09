#!/usr/bin/env node
import { isRetrievalArgv, runRetrievalCli } from "./retrieval/service.js";
import { run } from "./wrapper/run.js";

function stripCcLhcFlags(argv: string[]): {
  argv: string[];
  noCapture: boolean;
  noInference: boolean;
} {
  const out: string[] = [];
  let noCapture = false;
  let noInference = process.env.CC_LHC_NO_INFERENCE === "1";
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
      console.error(`Unknown cc-lhc flag: ${arg} (cc-lhc owns the --lhc-* namespace)`);
      process.exit(2);
    }
    out.push(arg);
  }
  return { argv: out, noCapture, noInference };
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

  const exitCode = await run(parsed.argv, {
    noCapture: parsed.noCapture,
    noInference: parsed.noInference,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  });

  // Wrapper path may need force-exit for PTY lifecycle; retrieval does not.
  process.exit(exitCode);
}
