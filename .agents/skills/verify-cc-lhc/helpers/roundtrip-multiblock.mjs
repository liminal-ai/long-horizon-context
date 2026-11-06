#!/usr/bin/env node
// Runs a two-text-block assistant reply through the production path (cc-lhc intake mapping,
// lhc intake, drain and session view, cc-lhc rollout writer) and writes the source and rebuilt
// transcripts, so the content check can be graded on a real multi-block rebuild.
// usage: roundtrip-multiblock.mjs REPO_ROOT SCRATCH_DIR OUT_DIR
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, scratchRoot, out] = process.argv.slice(2);
const { initLhc, createDeterministicInferenceCallbacks, threads } = await import(
  join(repo, "packages/lhc/dist/index.js")
);
const { mapRolloutLines } = await import(join(repo, "packages/cc-lhc/dist/intake/map.js"));
const { buildRolloutLines, runtimeNoteRolloutLine, serializeRolloutLines } = await import(
  join(repo, "packages/cc-lhc/dist/rollout/rebuild.js")
);

const must = (r) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r;
};
const scratch = mkdtempSync(join(scratchRoot, "roundtrip-multiblock-"));
const filePath = join(scratch, "thread.sqlite");
must(await threads.newThread({ filePath, registryPath: join(scratch, "registry.sqlite"), cwd: scratch, title: "multi-block" }));
const sdk = initLhc({ mode: "manual", tokenFamily: "claude-2026", inferenceCallbacks: createDeterministicInferenceCallbacks() });
const source = [
  { type: "user", uuid: "user-one", message: { role: "user", content: "Please compare alpha and beta." } },
  {
    type: "assistant",
    uuid: "assistant-one",
    message: { role: "assistant", content: [{ type: "text", text: "Alpha is first." }, { type: "text", text: "Beta is second." }] },
  },
];
const mapped = mapRolloutLines(source);
mapped.events.push({ eventKind: "turn_end", idempotencyKey: "turn-end", actor: "system", harness: "cc", payload: {} });
must(await sdk.intakeStream.messageEvents({ filePath }, mapped.events));
must(await sdk.work.drain({ filePath }));
const view = must(await sdk.threadView.getSessionThreadView({ filePath }));
const envelope = { cwd: scratch, version: "2.1.317" };
const sid = "00000000-0000-4000-8000-000000000002";
const rebuilt = buildRolloutLines({ entries: view.value.entries, newSessionId: sid, envelope });
rebuilt.push(runtimeNoteRolloutLine("multi-block roundtrip", sid, envelope, rebuilt.at(-1).line.uuid));
writeFileSync(join(out, "multiblock-source.jsonl"), source.map((l) => JSON.stringify(l)).join("\n") + "\n");
writeFileSync(join(out, "multiblock-rebuilt.jsonl"), serializeRolloutLines(rebuilt));
rmSync(scratch, { recursive: true, force: true });
console.log(`wrote multiblock pair (${rebuilt.length} rebuilt lines) to ${out}`);
