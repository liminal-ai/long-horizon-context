/**
 * Subprocess worker for flush-safety: run retrieval CLI to process.stdout.
 * Launched via: tsx retrieval-flush-worker.ts
 * Env: CC_LHC_RUNTIME_DESCRIPTOR, CLAUDE_CODE_SESSION_ID, WORKER_OP, WORKER_IDS
 */
import { runRetrievalCli } from "../../src/retrieval/service.js";

const op = process.env.WORKER_OP ?? "get-turns";
const ids = (process.env.WORKER_IDS ?? "t1").split(/\s+/).filter(Boolean);
const argv = [op, ...ids];

const code = await runRetrievalCli(argv, {
  stdout: process.stdout,
  stderr: process.stderr,
}).catch((e: unknown) => {
  console.error(String(e));
  return 1;
});
// Flush-safe path: set exitCode, do not process.exit() immediately.
process.exitCode = code;
