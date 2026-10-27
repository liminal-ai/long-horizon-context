import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const LHC_DIST = join(REPO_ROOT, "packages", "lhc", "dist", "index.js");
export const LHC_BIN = join(REPO_ROOT, "packages", "lhc", "bin", "lhc");

export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

export function unwrap(result, label) {
  if (!result || result.ok !== true) {
    fail(`${label}: ${JSON.stringify(result)?.slice(0, 400)}`);
  }
  return result.value;
}

export function tempHome(prefix = "verify-lhc-") {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(home, "threads"), { recursive: true });
  return {
    home,
    registryPath: join(home, "registry.sqlite"),
    threadPath: (name = "thread") => join(home, "threads", `${name}.sqlite`),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

export async function loadSdk() {
  try {
    return await import(LHC_DIST);
  } catch {
    fail(`lhc dist not built at ${LHC_DIST}; run: pnpm install --filter lhc && pnpm --filter lhc run build`);
  }
}

export async function makeSdk() {
  const mod = await loadSdk();
  return mod.initLhc({
    tokenFamily: "o200k",
    mode: "manual",
    inferenceCallbacks: mod.createDeterministicInferenceCallbacks(),
  });
}

let keyCounter = 0;
export function event(kind, payload) {
  keyCounter += 1;
  return { eventKind: kind, idempotencyKey: `verify-lhc-${keyCounter}`, actor: "verify-lhc", harness: "verify-lhc", payload };
}

// Six closed turns: enough history for compact to install a view and for
// retrieval to serve both early and late ids.
export function seededEvents(turns = 6) {
  const events = [];
  for (let t = 1; t <= turns; t += 1) {
    events.push(event("user_prompt", { text: `turn ${t}: investigate area ${t} please` }));
    if (t === 2) {
      events.push(event("tool_call", { toolCallId: "call-1", toolName: "read", arguments: { path: "notes.txt" } }));
      events.push(event("tool_result", { toolCallId: "call-1", content: "the file says hello", isError: false }));
    }
    events.push(event("assistant_text", { text: `findings for area ${t}: detail `.repeat(6) }));
    events.push(event("turn_end", {}));
  }
  return events;
}

export async function seedThread(sdk, store, turns = 6) {
  const filePath = store.threadPath();
  const created = unwrap(await sdk.threads.newThread({ filePath, registryPath: store.registryPath, title: "verify-lhc seed" }), "newThread");
  unwrap(await sdk.intakeStream.messageEvents({ filePath }, seededEvents(turns)), "messageEvents");
  unwrap(await sdk.work.drain({ filePath }), "drain");
  return { filePath, threadId: created.threadId };
}
