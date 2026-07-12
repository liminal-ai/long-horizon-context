#!/usr/bin/env node
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

const parsed = stripCcLhcFlags(process.argv.slice(2));

const exitCode = await run(parsed.argv, {
  noCapture: parsed.noCapture,
  noInference: parsed.noInference,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  return 1;
});

process.exit(exitCode);
