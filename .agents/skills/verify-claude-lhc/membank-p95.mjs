#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const P95_BAR_MS = 20;
const MAX_BAR_MS = 100;

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    bank: { type: "string" },
    id: { type: "string" },
    title: { type: "string" },
    dir: { type: "string" },
    calls: { type: "string", default: "100" },
  },
});
if (!values.socket || !values.bank || !values.id || !values.title || !values.dir) {
  console.error("usage: membank-p95.mjs --socket <membase socket> --bank <bank> --id <item id> --title <item title> --dir <fixture parent dir> [--calls N]");
  process.exit(2);
}

const req = createRequire(join(REPO, "packages/claude-lhc/package.json"));
const imp = (p) => import(pathToFileURL(p).href);
mkdirSync(values.dir, { recursive: true });
const fixture = mkdtempSync(join(values.dir, "membank-p95-"));
let out;
try {
  const { Client } = await imp(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
  const { InMemoryTransport } = await imp(req.resolve("@modelcontextprotocol/sdk/inMemory.js"));
  const lhcMod = await imp(join(REPO, "packages/lhc/dist/index.js"));
  const { createRetrievalServer } = await imp(join(REPO, "packages/claude-lhc/dist/retrieval.js"));
  const lhc = await lhcMod.initLhc({ mode: "manual", inferenceCallbacks: lhcMod.createDeterministicInferenceCallbacks(), tokenFamily: "claude-2026", membase: { socketPath: values.socket } });
  const registryPath = join(fixture, "registry.sqlite");
  const created = await lhc.threads.newThread({ filePath: join(fixture, "thread.sqlite"), cwd: fixture, title: "membank-p95", registryPath });
  if (!created.ok) throw new Error(`newThread: ${JSON.stringify(created.error)}`);
  const ref = { threadId: created.value.threadId, registryPath };
  const attached = await lhc.membank.attach(ref, values.bank);
  if (!attached.ok) throw new Error(`attach ${values.bank}: ${attached.error.reason}`);
  const logged = [];
  const server = createRetrievalServer(lhc, () => ref, { log: (line) => logged.push(line) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "membank-p95", version: "0" });
  await client.connect(clientSide);
  for (let i = 0; i < Number(values.calls); i += 1) {
    const result = await client.callTool({ name: "membank_get", arguments: { id: values.id } });
    if (result.isError || !result.content[0].text.includes(`title ${values.title}`)) throw new Error(`membank_get ${values.id} answered ${JSON.stringify(result)}`);
  }
  await client.close();
  const ms = logged.map((line) => Number(/answered in ([\d.]+) ms/.exec(line)[1]));
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  out = { calls: ms.length, first: ms[0], p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
  out.pass = out.calls === Number(values.calls) && out.p95 < P95_BAR_MS && out.max <= MAX_BAR_MS;
} catch (error) {
  out = { pass: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
process.exit(out.pass ? 0 : 1);
