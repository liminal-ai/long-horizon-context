#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LHC_BIN, fail, makeSdk, seedThread, tempHome, unwrap } from "./lib.mjs";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const homeArg = args.includes("--home") ? args[args.indexOf("--home") + 1] : undefined;
const store = homeArg
  ? { home: homeArg, registryPath: join(homeArg, "registry.sqlite"), threadPath: (n = "thread") => join(homeArg, "threads", `${n}.sqlite`), cleanup: () => {} }
  : tempHome();
if (homeArg) mkdirSync(join(homeArg, "threads"), { recursive: true });

try {
  const sdk = await makeSdk();
  const { filePath, threadId } = await seedThread(sdk, store);
  console.log(`created ${threadId} at ${filePath}`);

  const turns = unwrap(await sdk.turns.listTurns({ filePath }), "listTurns");
  const closed = turns.filter((t) => t.turnId !== undefined);
  if (closed.length < 6) fail(`expected >=6 turns, got ${closed.length}`);
  console.log(`appended turns: ${closed.map((t) => t.turnId).join(",")}`);

  const before = unwrap(await sdk.threadView.getLlmRequestContext({ filePath }), "serve before compact");
  if (!JSON.stringify(before).includes("turn 1: investigate area 1")) fail("serve before compact lost turn 1");

  const receipt = unwrap(await sdk.threadView.compact({ filePath }, {}), "compact");
  console.log(`compact ok viewId=${receipt.viewId} profile=${receipt.profile}`);

  const after = unwrap(await sdk.threadView.getLlmRequestContext({ filePath }), "serve after compact");
  if (!Array.isArray(after.messages) || after.messages.length === 0) fail("serve after compact returned no messages");
  const served = JSON.stringify(after);
  if (!served.includes("investigate area") && !served.includes("findings for area")) fail("serve after compact lost seeded content");
  console.log(`served ${after.messages.length} messages after compact`);

  const health = execFileSync("node", [LHC_BIN, "thread", "health", "--home", store.home, "--thread-id", threadId], { encoding: "utf8" });
  console.log(`cli health: ${health.trim().slice(0, 200)}`);

  console.log("verify-lhc round-trip: PASS");
  if (keep || homeArg) console.log(`home kept at ${store.home}`);
} finally {
  if (!keep && !homeArg) store.cleanup();
}
