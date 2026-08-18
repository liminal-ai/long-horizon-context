/**
 * Separate-process registry alias worker for the R15 concurrency evidence.
 * Invoked via: tsx registry-alias-multiproc-worker.ts <specJson> <outJson> <readyPath> <goPath>
 *
 * Barrier protocol matches write-lock-multiproc-worker.ts:
 * 1. Worker finishes imports, then writes READY to readyPath.
 * 2. Worker waits until goPath exists.
 * 3. Parent waits for READY from every worker, then writes goPath so all sides
 *    hit the registry at once.
 *
 * Modes:
 *  advance — register a fresh alias as current, repeatedly.
 *  resolve — read the thread's current alias and prove the pair is consistent.
 *  claim   — race every worker to register ONE shared alias against its own thread.
 */
import { existsSync, writeFileSync } from "node:fs";

import { threads } from "../../src/index.js";

interface WorkerSpec {
  mode: "advance" | "resolve" | "claim";
  registryPath: string;
  threadId: string;
  rounds: number;
  workerId: string;
  seedAlias?: string;
  sharedAlias?: string;
}

const specArg = process.argv[2];
const outPath = process.argv[3];
const readyPath = process.argv[4];
const goPath = process.argv[5];

if (!specArg || !outPath || !readyPath || !goPath) {
  console.error("usage: registry-alias-multiproc-worker.ts <specJson> <outJson> <readyPath> <goPath>");
  process.exit(2);
}

const spec = JSON.parse(specArg) as WorkerSpec;

writeFileSync(readyPath, `READY pid=${process.pid}\n`, "utf8");
const waitStart = Date.now();
while (!existsSync(goPath)) {
  if (Date.now() - waitStart > 30_000) {
    console.error("worker timeout waiting for go barrier");
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 5));
}

const registered: string[] = [];
const violations: string[] = [];
const failures: string[] = [];
let observations = 0;
let claimed: { ok: boolean; code?: string } = { ok: false };

// A current pointer must always name an alias registered to that same thread.
// If registration and advancement were separate commits, a reader between them
// would see a current alias that resolves to nothing — that is the violation
// this records rather than an incidental read failure.
async function proveCurrentIsResolvable(currentAlias: string): Promise<void> {
  const resolved = await threads.resolveAlias({ alias: currentAlias, registryPath: spec.registryPath });
  if (!resolved.ok) {
    violations.push(`current alias ${currentAlias} does not resolve: ${resolved.error.code}`);
    return;
  }
  if (resolved.value.threadId !== spec.threadId) {
    violations.push(`current alias ${currentAlias} resolves to ${resolved.value.threadId}, not ${spec.threadId}`);
  }
}

if (spec.mode === "advance") {
  for (let i = 0; i < spec.rounds; i += 1) {
    const alias = `claude-code:gen-${spec.workerId}-${i}`;
    const advanced = await threads.registerCurrentAlias({
      alias,
      threadId: spec.threadId,
      registryPath: spec.registryPath,
    });
    if (!advanced.ok) {
      failures.push(`${alias}: ${advanced.error.code} ${advanced.error.reason}`);
      continue;
    }
    registered.push(alias);
  }
}

if (spec.mode === "resolve") {
  const seedAlias = spec.seedAlias ?? "";
  for (let i = 0; i < spec.rounds; i += 1) {
    const current = await threads.currentAlias({ threadId: spec.threadId, registryPath: spec.registryPath });
    if (!current.ok) {
      failures.push(`current: ${current.error.code} ${current.error.reason}`);
    } else if (current.value.currentAlias === null) {
      violations.push("current alias went back to null after the thread accepted one");
    } else {
      observations += 1;
      await proveCurrentIsResolvable(current.value.currentAlias);
    }

    // Entry through the oldest alias must land on the thread and on an alias
    // that thread really holds — both from the one resolve read.
    const viaSeed = await threads.resolveAlias({ alias: seedAlias, registryPath: spec.registryPath });
    if (!viaSeed.ok) {
      violations.push(`seed alias ${seedAlias} stopped resolving: ${viaSeed.error.code}`);
      continue;
    }
    observations += 1;
    if (viaSeed.value.threadId !== spec.threadId) {
      violations.push(`seed alias resolved to ${viaSeed.value.threadId}, not ${spec.threadId}`);
    }
    if (viaSeed.value.currentAlias === null) {
      violations.push("resolve returned a null current alias after the thread accepted one");
      continue;
    }
    await proveCurrentIsResolvable(viaSeed.value.currentAlias);
  }
}

if (spec.mode === "claim") {
  const sharedAlias = spec.sharedAlias ?? "";
  const result = await threads.registerCurrentAlias({
    alias: sharedAlias,
    threadId: spec.threadId,
    registryPath: spec.registryPath,
  });
  claimed = result.ok ? { ok: true } : { ok: false, code: result.error.code };
}

writeFileSync(
  outPath,
  JSON.stringify({ mode: spec.mode, workerId: spec.workerId, registered, violations, failures, observations, claimed }),
  "utf8",
);
process.exit(violations.length === 0 && failures.length === 0 ? 0 : 1);
