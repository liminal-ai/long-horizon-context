/**
 * Concurrency worker: one session-owner acquisition attempt against a shared
 * home, using the production-default identity probe (the suite's stub addon
 * via CC_LHC_IDENTITY_ADDON, inherited through the environment).
 * Prints exactly one line: `WON <token>` or `LOST <ErrorName>`.
 *
 * A winner keeps its lease and stays alive until the parent creates the
 * `race-stop` file (cooperative shutdown — tsx runs the worker as a
 * grandchild, so signalling the spawned wrapper would orphan the real
 * process and leak its stdio pipes), so every concurrent loser observes a
 * live owner. A 30s safety timer guarantees exit even if the parent dies.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { acquireSessionOwner } from "../../src/runtime/session-owner.js";

const home = process.env.RACE_HOME;
const sessionId = process.env.RACE_SESSION;
if (home === undefined || sessionId === undefined) {
  process.stderr.write("session-owner-race-worker: RACE_HOME and RACE_SESSION are required\n");
  process.exit(2);
}

const stopFile = join(home, "race-stop");

try {
  const lease = acquireSessionOwner(sessionId, { home });
  process.stdout.write(`WON ${lease.token}\n`);
  const poll = setInterval(() => {
    if (existsSync(stopFile)) {
      clearInterval(poll);
      process.exit(0);
    }
  }, 100);
  setTimeout(() => process.exit(0), 30_000).unref();
} catch (cause) {
  const name = cause instanceof Error ? cause.name : "UnknownError";
  process.stdout.write(`LOST ${name}\n`);
  process.exit(0);
}
