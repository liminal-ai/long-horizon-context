#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runPiLhcLauncher } from "./launcher/run.js";

const DEFAULT_LHC_DIR = join(homedir(), ".lhc");

function defaultNewThreadFilePath(): string {
  const dir = join(DEFAULT_LHC_DIR, "threads");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID()}.sqlite`);
}

const exitCode = await runPiLhcLauncher(process.argv.slice(2), {
  newThreadFilePath: defaultNewThreadFilePath,
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  return 1;
});

process.exit(exitCode);
