#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fail, loadSdk, tempHome, unwrap } from "./lib.mjs";

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    bank: { type: "string" },
    "trunk-dist": { type: "string" },
    runs: { type: "string", default: "20" },
    calls: { type: "string", default: "500" },
  },
});
if (!values.socket || !values.bank) {
  fail("usage: membank-perf.mjs --socket <membase socket> --bank <seeded bank> [--trunk-dist <trunk packages/lhc/dist/index.js>]");
}
const runs = Number(values.runs);
const calls = Number(values.calls);

const percentile = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const median = (samples) => percentile(samples, 0.5);
const fmt = (ms) => `${ms.toFixed(3)} ms`;

const head = await loadSdk();
const trunk = values["trunk-dist"] ? await import(values["trunk-dist"]) : null;
const configFor = (mod) => ({ tokenFamily: "o200k", mode: "manual", inferenceCallbacks: mod.createDeterministicInferenceCallbacks() });
const membaseConfig = { ...configFor(head), membase: { socketPath: values.socket } };

const timed = async (fn) => {
  const startedAt = performance.now();
  await fn();
  return performance.now() - startedAt;
};

const samples = { trunk: [], head: [], headMembase: [] };
for (let i = 0; i < runs; i += 1) {
  if (trunk) samples.trunk.push(await timed(() => trunk.initLhc(configFor(trunk))));
  samples.head.push(await timed(() => head.initLhc(configFor(head))));
  samples.headMembase.push(await timed(() => head.initLhc(membaseConfig)));
}

const store = tempHome("verify-lhc-perf-");
let getP50;
let getP95;
try {
  const sdk = await head.initLhc(membaseConfig);
  const created = unwrap(await sdk.threads.newThread({ filePath: store.threadPath(), registryPath: store.registryPath }), "newThread");
  const ref = { threadId: created.threadId, registryPath: store.registryPath };
  unwrap(await sdk.membank.attach(ref, values.bank), "attach");
  const [first] = unwrap(await sdk.membank.list(ref), "list");
  if (!first) fail(`bank ${values.bank} has no items`);
  const getSamples = [];
  for (let i = 0; i < calls; i += 1) {
    getSamples.push(await timed(async () => unwrap(await sdk.membank.get(ref, first.id), "get")));
  }
  unwrap(await sdk.membank.detach(ref), "detach");
  getP50 = percentile(getSamples, 0.5);
  getP95 = percentile(getSamples, 0.95);
  console.log(`membank.get ${first.id} x${calls}: p50 ${fmt(getP50)} p95 ${fmt(getP95)}`);
} finally {
  store.cleanup();
}

const failures = [];
if (trunk) {
  console.log(`construction without membase x${runs}: trunk median ${fmt(median(samples.trunk))}, head median ${fmt(median(samples.head))}`);
  if (median(samples.head) - median(samples.trunk) > 5) failures.push("head construction median is more than 5 ms above trunk");
} else {
  console.log(`construction without membase x${runs}: head median ${fmt(median(samples.head))} (no --trunk-dist, trunk not measured)`);
}
const handshake = median(samples.headMembase) - median(samples.head);
console.log(`construction with membase x${runs}: median ${fmt(median(samples.headMembase))}, handshake adds ${fmt(handshake)}`);
if (handshake > 50) failures.push("the membase handshake adds more than 50 ms");
if (getP95 > 10) failures.push("membank.get p95 is over 10 ms");

if (failures.length > 0) fail(failures.join("; "));
console.log("verify-lhc membank-perf: PASS");
