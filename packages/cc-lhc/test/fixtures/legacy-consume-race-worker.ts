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
