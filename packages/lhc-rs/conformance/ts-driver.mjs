// Leg-1 TS driver: build a fresh v5 thread with adversarial host facts.
import { threads, intakeStream, messages } from "../../lhc/dist/index.js";
const filePath = process.argv[2];
const registryPath = process.argv[3];
const mode = process.argv[4]; // "create" | "open"
const usage = {
  input_tokens: 9007199254740991,
  cached_input_tokens: 0.1,
  huge: 1e21,
  "astral-𝔘": "naïve✓𝒳",
  nested: { cache_write: 0, provider: "openai-codex", ratio: 1e-7 },
};
if (mode === "create") {
  const created = await threads.newThread({ filePath, registryPath });
  if (!created.ok) throw new Error(created.error.reason);
  const batch = [
    { eventKind: "user_prompt", actor: "user", harness: "conformance", idempotencyKey: "k1", payload: { text: "conformance v5 prompt" } },
    { eventKind: "assistant_text", actor: "assistant", harness: "conformance", idempotencyKey: "k2", payload: { text: "answer one", providerUsage: usage } },
    { eventKind: "turn_end", actor: "system", harness: "conformance", idempotencyKey: "k3", payload: { outcome: "aborted", outcomeReason: "user cancelled ✂", startedAt: "2026-07-01T12:00:00.000Z", endedAt: "2026-07-01T12:00:04.250Z" } },
    { eventKind: "user_prompt", actor: "user", harness: "conformance", idempotencyKey: "k4", payload: { text: "second" } },
    { eventKind: "assistant_text", actor: "assistant", harness: "conformance", idempotencyKey: "k5", payload: { text: "no usage" } },
    { eventKind: "turn_end", actor: "system", harness: "conformance", idempotencyKey: "k6", payload: {} },
  ];
  const sent = await intakeStream.messageEvents({ filePath }, batch);
  if (!sent.ok) throw new Error(sent.error.reason);
} else {
  const listed = await messages.list({ filePath }); // open path -> migration runs
  if (!listed.ok) throw new Error(listed.error.reason);
}
console.log("ts-driver ok:", mode);
