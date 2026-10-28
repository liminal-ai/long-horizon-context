import { existsSync } from "node:fs";
import { join } from "node:path";

import { acquireThreadOwner } from "../../src/runtime/thread-owner.js";

const home = process.env.RACE_HOME;
const threadId = process.env.RACE_THREAD;
if (home === undefined || threadId === undefined) {
  process.stderr.write("thread-owner-race-worker: RACE_HOME and RACE_THREAD are required\n");
  process.exit(2);
}

const stopFile = join(home, "race-stop");

try {
  const lease = acquireThreadOwner(threadId, { home });
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
