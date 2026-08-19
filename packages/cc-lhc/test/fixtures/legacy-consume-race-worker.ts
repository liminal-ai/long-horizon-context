/**
 * Concurrency worker: one wrapper's pre-rewrite state consumption, under its
 * own thread lease, against a cc-lhc home shared with another thread's wrapper.
 *
 * Prints exactly one line: `DONE <threadId> <files> <rows>`. Both workers wait
 * on a `consume-go` file so their consumption overlaps rather than queueing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { acquireThreadOwner } from "../../src/runtime/thread-owner.js";
import { consumeLegacyHandoffState } from "../../src/wrapper/legacy-handoff-state.js";

const home = process.env.RACE_HOME;
const threadId = process.env.RACE_THREAD;
if (home === undefined || threadId === undefined) {
  process.stderr.write("legacy-consume-race-worker: RACE_HOME and RACE_THREAD are required\n");
  process.exit(2);
}

// Each worker owns a DIFFERENT thread, so both leases are granted and both
// run at once — exactly the case the shared stores must survive.
const lease = acquireThreadOwner(threadId, { home });
const goFile = join(home, "consume-go");
const startMs = Date.now();
while (!existsSync(goFile)) {
  if (Date.now() - startMs > 20_000) break;
}

try {
  const outcome = consumeLegacyHandoffState({
    home,
    lineageDbPath: join(home, "cc-lhc.sqlite"),
    threadId,
  });
  process.stdout.write(`DONE ${threadId} ${outcome.legacyRecoveryFiles} ${outcome.legacyAttemptRows}\n`);
} finally {
  lease.release();
}
process.exit(0);
