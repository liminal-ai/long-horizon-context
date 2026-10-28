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
process.exitCode = code;
