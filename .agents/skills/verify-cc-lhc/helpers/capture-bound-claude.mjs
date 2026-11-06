#!/usr/bin/env node
// The repo stand-in writes its transcript and exits within milliseconds, before cc-lhc's
// capture discovers and binds the file, so nothing would be ingested. This runs it, then
// holds the child seat open until wrapper.log shows this run's capture bound (or degraded).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const standin = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/cc-lhc/test/fixtures/oneshot-claude.mjs");
const log = join(process.env.CC_LHC_HOME ?? join(homedir(), ".cc-lhc"), "wrapper.log");
const start = existsSync(log) ? statSync(log).size : 0;

const child = spawnSync(process.execPath, [standin, ...process.argv.slice(2)], { stdio: "inherit" });
const rc = child.status ?? 1;
if (rc !== 0) process.exit(rc);

const deadline = Date.now() + Number(process.env.VERIFY_CC_LHC_BIND_WAIT_MS ?? 20000);
for (;;) {
  const tail = existsSync(log) ? readFileSync(log).subarray(start).toString("utf8") : "";
  if (/cc-lhc capture ready|capture degraded/.test(tail)) break;
  if (Date.now() >= deadline) {
    process.stderr.write(`capture-bound-claude: no capture ready line in ${log} before the deadline\n`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
process.exit(0);
