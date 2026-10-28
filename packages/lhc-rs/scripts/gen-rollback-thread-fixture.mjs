#!/usr/bin/env node
/**
 * TS-written thread with a logged rollback, for the Rust read-compatibility
 * test (tests/rollback_read_compat.rs). Two closed turns, then a rollback that
 * keeps the first, then a drain.
 *
 * Regenerate (from packages/lhc-rs, with packages/lhc built):
 *   node scripts/gen-rollback-thread-fixture.mjs
 * Writes fixtures/rollback-thread.sqlite.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createDeterministicInferenceCallbacks, initLhc } from "../../lhc/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "fixtures", "rollback-thread.sqlite");

function unwrap(result) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

let key = 0;
const event = (eventKind, payload) => ({
  eventKind,
  payload,
  idempotencyKey: `rollback-fixture-${++key}`,
  actor: "fixture",
  harness: "fixture",
});
const turn = (marker) => [
  event("user_prompt", { text: `${marker} prompt` }),
  event("assistant_text", { text: `${marker} answer` }),
  event("turn_end", {}),
];

const home = mkdtempSync(join(tmpdir(), "lhc-rollback-fixture-"));
try {
  const sdk = initLhc({
    tokenFamily: "o200k",
    mode: "manual",
    inferenceCallbacks: createDeterministicInferenceCallbacks(),
  });
  const ref = { filePath: join(home, "thread.sqlite") };
  unwrap(await sdk.threads.newThread({ ...ref, registryPath: join(home, "registry.sqlite") }));
  unwrap(await sdk.intakeStream.messageEvents(ref, turn("KEPT")));
  unwrap(await sdk.intakeStream.messageEvents(ref, turn("ROLLED_BACK")));
  unwrap(
    await sdk.intakeStream.messageEvents(ref, [
      event("rollback", { keepThroughEventOrder: 3, reason: "host rewind" }),
    ]),
  );
  unwrap(await sdk.work.drain(ref));
  rmSync(out, { force: true });
  const source = new DatabaseSync(ref.filePath);
  try {
    source.exec(`VACUUM INTO '${out}'`);
  } finally {
    source.close();
  }
  // Smallest page size keeps the committed binary small; rows are untouched.
  const copy = new DatabaseSync(out);
  try {
    copy.exec("PRAGMA page_size = 512; VACUUM;");
  } finally {
    copy.close();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
