/**
 * Concurrency worker: one full launch-thread acquisition against a shared
 * cc-lhc home, entering through whichever alias of the thread it was given.
 * Prints exactly one line: `WON <threadId> <landedSessionId>` or
 * `LOST <ErrorName>`.
 *
 * A winner keeps its lease and stays alive until the parent creates the
 * `race-stop` file (cooperative shutdown — tsx runs the worker as a
 * grandchild, so signalling the spawned wrapper would orphan the real
 * process and leak its stdio pipes), so every concurrent loser observes a
 * live owner. A 30s safety timer guarantees exit even if the parent dies.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { openLaunchThread } from "../../src/intake/launch-thread.js";

const home = process.env.RACE_HOME;
const sessionId = process.env.RACE_SESSION;
if (home === undefined || sessionId === undefined) {
  process.stderr.write("launch-alias-race-worker: RACE_HOME and RACE_SESSION are required\n");
  process.exit(2);
}

const stopFile = join(home, "race-stop");

try {
  const opened = await openLaunchThread({
    expectedSession: { sessionId, source: "explicit_resume" },
    registryPath: join(home, "registry.sqlite"),
    lineageDbPath: join(home, "cc-lhc.sqlite"),
    home,
    createThread: async () => {
      throw new Error("launch-alias-race-worker: the thread must already exist");
    },
  });
  process.stdout.write(`WON ${opened.threadId} ${opened.expectedSession.sessionId}\n`);
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
