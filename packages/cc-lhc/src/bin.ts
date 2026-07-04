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
    if (arg === "--no-capture") {
      noCapture = true;
      continue;
    }
    if (arg === "--no-inference") {
      noInference = true;
      continue;
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
