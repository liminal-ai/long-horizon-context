#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fail, loadSdk, tempHome, unwrap } from "./lib.mjs";

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    bank: { type: "string" },
    expect: { type: "string" },
    "expect-unreachable": { type: "boolean", default: false },
  },
});
if (!values.socket) fail("usage: membank.mjs --socket <membase socket> (--bank <name> [--expect <items.json>] | --expect-unreachable)");

const mod = await loadSdk();
const config = {
  tokenFamily: "o200k",
  mode: "manual",
  inferenceCallbacks: mod.createDeterministicInferenceCallbacks(),
  membase: { socketPath: values.socket },
};

if (values["expect-unreachable"]) {
  const startedAt = performance.now();
  const outcome = await mod.initLhc(config).then(
    () => null,
    (error) => error,
  );
  const ms = performance.now() - startedAt;
  if (outcome === null) fail("initLhc constructed with membase configured; expected membase_unreachable");
  console.log(`initLhc rejected after ${ms.toFixed(1)} ms: ${outcome.name} ${outcome.code}: ${outcome.message}`);
  if (outcome.name !== "MembaseHandshakeError" || outcome.code !== "membase_unreachable") fail("expected MembaseHandshakeError membase_unreachable");
  if (ms >= 5_000) fail(`construction took ${ms.toFixed(1)} ms; expected under 5000 ms`);
  console.log("verify-lhc membank unreachable: PASS");
  process.exit(0);
}

if (!values.bank) fail("--bank <name> is required unless --expect-unreachable is set");
const store = tempHome();
try {
  const sdk = await mod.initLhc(config);
  const created = unwrap(await sdk.threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath }), "newThread");
  const ref = { threadId: created.threadId, registryPath: store.registryPath };
  console.log(`thread ${created.threadId}`);

  const before = await sdk.membank.attachment(ref);
  if (before.ok || before.error.code !== "not_attached") fail(`fresh thread attachment should be not_attached: ${JSON.stringify(before)}`);
  const attached = unwrap(await sdk.membank.attach(ref, values.bank), "attach");
  console.log(`attached ${attached.threadId} to ${attached.bank} by ${attached.machine}`);

  const summaries = unwrap(await sdk.membank.list(ref), "list");
  if (summaries.length === 0) fail(`bank ${values.bank} has no items; seed it through verify-membase first`);
  const items = [];
  for (const summary of summaries) {
    const item = unwrap(await sdk.membank.get(ref, summary.id), `get ${summary.id}`);
    for (const field of ["id", "kind", "title", "description", "status"]) {
      if (item[field] !== summary[field]) fail(`${summary.id}: get ${field} ${JSON.stringify(item[field])} differs from list ${JSON.stringify(summary[field])}`);
    }
    items.push(item);
    console.log(`${item.id}\t${item.kind}\t${item.title}\t${item.description}\tbody=${JSON.stringify(item.body)}`);
  }

  if (values.expect) {
    const expected = JSON.parse(readFileSync(values.expect, "utf8"));
    const got = items.map(({ id, title, description, body }) => ({ id, title, description, body }));
    if (JSON.stringify(got) !== JSON.stringify(expected)) fail(`items differ from ${values.expect}:\n${JSON.stringify(got, null, 2)}`);
    console.log(`items match ${values.expect}`);
  }

  const missing = await sdk.membank.get(ref, "L999999");
  if (missing.ok || missing.error.code !== "item_not_found") fail(`L999999 should be item_not_found: ${JSON.stringify(missing)}`);
  console.log(`L999999: ${missing.error.code} (${missing.error.reason})`);

  unwrap(await sdk.membank.detach(ref), "detach");
  const after = await sdk.membank.list(ref);
  if (after.ok || after.error.code !== "not_attached") fail(`list after detach should be not_attached: ${JSON.stringify(after)}`);
  console.log("detached; list answers not_attached");
  console.log("verify-lhc membank: PASS");
} finally {
  store.cleanup();
}
