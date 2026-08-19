/**
 * Stands in for a concurrent wrapper accepting a swap: binds ACCEPT_SESSION as
 * the current session of ACCEPT_THREAD in the registry at ACCEPT_REGISTRY, then
 * exits. Run as a separate process so the write is genuinely another writer's.
 */

import { acceptCurrentSession } from "../../src/intake/thread-alias.js";

const registryPath = process.env.ACCEPT_REGISTRY;
const threadId = process.env.ACCEPT_THREAD;
const sessionId = process.env.ACCEPT_SESSION;
if (registryPath === undefined || threadId === undefined || sessionId === undefined) {
  process.stderr.write("accept-current-session: ACCEPT_REGISTRY, ACCEPT_THREAD and ACCEPT_SESSION are required\n");
  process.exit(2);
}

const advanced = await acceptCurrentSession({ sessionId, threadId, registryPath });
if (!advanced.ok) {
  process.stderr.write(`accept-current-session: ${advanced.reason}\n`);
  process.exit(1);
}
