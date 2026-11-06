#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, REPO_ROOT, reportFailure } from "./lib.mjs";

const RUN_TIMEOUT_MS = 600_000;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { runs: { type: "string", default: "20" }, log: { type: "string" } },
  });
  const runs = Number(values.runs);
  if (!values.log || positionals.length === 0 || !Number.isInteger(runs) || runs < 1) {
    fail("usage: repeat-test.mjs --runs <n> --log <file> <packages/lhc test file>...");
  }
  const log = resolve(values.log);
  mkdirSync(dirname(log), { recursive: true });
  for (let run = 1; run <= runs; run += 1) {
    const result = spawnSync("pnpm", ["--filter", "lhc", "exec", "vitest", "run", ...positionals], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
    });
    const output = `${result.stdout}${result.stderr}`;
    appendFileSync(log, `=== run ${run} of ${runs}: exit ${result.status} signal ${result.signal}\n${output}\n`);
    if (result.status !== 0) fail(`run ${run} of ${runs} exited ${result.status ?? result.signal}; log ${log}`);
    if (output.includes("No test files found")) fail(`run ${run} of ${runs} found no test files; log ${log}`);
    console.log(`run ${run} of ${runs}: pass`);
  }
  console.log(`verify-lhc repeat-test: PASS ${runs} of ${runs} (log ${log})`);
} catch (error) {
  reportFailure(error);
}
