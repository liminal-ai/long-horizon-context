#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repoRoot, ccLhcHome, workDir, codeword] = process.argv.slice(2);
if (!repoRoot || !ccLhcHome || !workDir || !codeword) {
  console.error("usage: seed-thread.mjs <repoRoot> <ccLhcHome> <workDir> <codeword>");
  process.exit(2);
}
const { createDeterministicInferenceCallbacks, initLhc, threads } = await import(
  pathToFileURL(join(repoRoot, "packages/lhc/dist/index.js")).href
);

mkdirSync(join(ccLhcHome, "threads"), { recursive: true });
const registryPath = join(ccLhcHome, "registry.sqlite");
const filePath = join(ccLhcHome, "threads", "verify-seed.sqlite");
const created = await threads.newThread({ filePath, registryPath, title: "verify-cc-lhc seed", cwd: workDir });
if (!created.ok) {
  console.error(`seed: newThread failed: ${created.error.reason}`);
  process.exit(1);
}
const sdk = initLhc({
  mode: "manual",
  tokenFamily: "claude-2026",
  inferenceCallbacks: createDeterministicInferenceCallbacks(),
});

async function seedTurn(prompt, answer) {
  const events = [
    { eventKind: "user_prompt", idempotencyKey: `u-${prompt}`, actor: "user", harness: "cc", payload: { text: prompt } },
    { eventKind: "assistant_text", idempotencyKey: `a-${answer}`, actor: "assistant", harness: "cc", payload: { text: answer } },
    { eventKind: "turn_end", idempotencyKey: `e-${prompt}`, actor: "system", harness: "cc", payload: {} },
  ];
  const send = await sdk.intakeStream.messageEvents({ filePath }, events);
  if (!send.ok) throw new Error(send.error.reason);
  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);
}

await seedTurn(`seed prompt: the codeword is ${codeword}`, `noted the codeword ${codeword}`);
await seedTurn("second seeded turn", "second seeded answer");
console.log(`${created.value.threadId} ${filePath}`);
