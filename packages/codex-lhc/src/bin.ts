#!/usr/bin/env node
import { prepareChildArgv } from "./bin/prepare-child-argv.js";
import { run } from "./wrapper/run.js";

const parsed = prepareChildArgv(process.argv.slice(2));

const exitCode = await run(parsed.argv, {
  noCapture: parsed.noCapture,
  noInference: parsed.noInference,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  return 1;
});

process.exit(exitCode);
