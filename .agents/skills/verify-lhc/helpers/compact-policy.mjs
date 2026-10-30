#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { backup, DatabaseSync } from "node:sqlite";
import { LHC_BIN, fail, makeSdk, seedThread, tempHome, unwrap } from "./lib.mjs";

const args = process.argv.slice(2);
const migrateSource = args.includes("--migrate") ? args[args.indexOf("--migrate") + 1] : undefined;

function readFacts(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return {
      userVersion: Number(db.prepare("PRAGMA user_version").get().user_version),
      events: Number(db.prepare("SELECT COUNT(*) AS n FROM event").get().n),
      metadata: db.prepare("SELECT * FROM thread_metadata WHERE id = 1").get(),
    };
  } finally {
    db.close();
  }
}

async function migrate(sdk, store, source) {
  const filePath = store.threadPath("migrated");
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  let sourceFacts;
  try {
    sourceFacts = {
      userVersion: Number(sourceDb.prepare("PRAGMA user_version").get().user_version),
      events: Number(sourceDb.prepare("SELECT COUNT(*) AS n FROM event").get().n),
    };
    await backup(sourceDb, filePath);
  } finally {
    sourceDb.close();
  }
  const before = readFacts(filePath);
  console.log(`source ${source} user_version=${sourceFacts.userVersion} events=${sourceFacts.events}`);
  console.log(`copy before open user_version=${before.userVersion} events=${before.events}`);
  console.log(`copy before open thread_metadata=${JSON.stringify(before.metadata)}`);

  const started = performance.now();
  unwrap(await sdk.threads.info({ filePath }), "open and migrate");
  console.log(`open+migrate ms=${(performance.now() - started).toFixed(1)}`);
  const policy = unwrap(await sdk.threads.getCompactPolicy({ filePath }), "getCompactPolicy");
  const after = readFacts(filePath);
  console.log(`copy after open user_version=${after.userVersion} events=${after.events}`);
  console.log(`copy after open thread_metadata=${JSON.stringify(after.metadata)}`);
  console.log(`compact policy=${JSON.stringify(policy)}`);

  if (after.userVersion !== 14) fail(`copy reads user_version ${after.userVersion}, expected 14`);
  if (policy !== null) fail(`migrated thread has a policy ${JSON.stringify(policy)}, expected null`);
  if (after.events !== sourceFacts.events) fail(`copy holds ${after.events} events, source ${sourceFacts.events}`);
  console.log("verify-lhc compact-policy migrate: PASS");
}

async function seeded(sdk, store) {
  const { filePath, threadId } = await seedThread(sdk, store);
  const fresh = unwrap(await sdk.threads.getCompactPolicy({ filePath }), "getCompactPolicy fresh");
  if (fresh !== null) fail(`new thread has a policy ${JSON.stringify(fresh)}, expected null`);
  console.log(`new thread ${threadId} policy=null`);

  unwrap(await sdk.threads.setCompactPolicy({ filePath }, { trigger: 700000, target: 140000 }), "setCompactPolicy");
  const stored = unwrap(
    await sdk.threads.getCompactPolicy({ threadId, registryPath: store.registryPath }),
    "getCompactPolicy by id",
  );
  if (stored?.trigger !== 700000 || stored?.target !== 140000) fail(`read back ${JSON.stringify(stored)}`);
  console.log(`stored policy=${JSON.stringify(stored)}`);

  const refused = await sdk.threads.setCompactPolicy({ filePath }, { trigger: 100000, target: 100000 });
  if (refused.ok || refused.error.code !== "invalid_compact_policy") fail(`target == trigger not refused: ${JSON.stringify(refused)}`);
  const unchanged = unwrap(await sdk.threads.getCompactPolicy({ filePath }), "getCompactPolicy after refusal");
  if (unchanged?.trigger !== 700000) fail(`refusal changed the stored pair: ${JSON.stringify(unchanged)}`);
  console.log(`refused target==trigger: ${refused.error.reason}`);

  const copied = unwrap(
    await sdk.threads.copyThread({ source: { filePath }, filePath: store.threadPath("copy"), registryPath: store.registryPath }),
    "copyThread",
  );
  const carried = unwrap(await sdk.threads.getCompactPolicy({ filePath: copied.filePath }), "getCompactPolicy copy");
  if (carried?.trigger !== 700000 || carried?.target !== 140000) fail(`copy carried ${JSON.stringify(carried)}`);
  console.log(`copy ${copied.threadId} policy=${JSON.stringify(carried)}`);

  const fork = spawnSync(
    process.execPath,
    [LHC_BIN, "thread", "fork", "--source-file", filePath, "--source-host", "cc-lhc", "--home", store.home, "--host", "claude-lhc", "--session-id", "verify-fork", "--token-family", "o200k", "--no-repair"],
    { encoding: "utf8" },
  );
  if (fork.status !== 0) fail(`fork into claude-lhc: exit ${fork.status} stderr ${fork.stderr.trim()}`);
  const [forkedId, forkedPath] = fork.stdout.trim().split(" ");
  const forked = unwrap(await sdk.threads.getCompactPolicy({ filePath: forkedPath }), "getCompactPolicy fork");
  if (forked?.trigger !== 700000 || forked?.target !== 140000) fail(`fork carried ${JSON.stringify(forked)}`);
  console.log(`fork ${forkedId} policy=${JSON.stringify(forked)}`);
  console.log("verify-lhc compact-policy: PASS");
}

const store = tempHome();
try {
  const sdk = await makeSdk();
  if (migrateSource !== undefined) await migrate(sdk, store, migrateSource);
  else await seeded(sdk, store);
} finally {
  store.cleanup();
}
