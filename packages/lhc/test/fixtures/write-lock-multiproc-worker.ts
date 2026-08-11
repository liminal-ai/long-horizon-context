/**
 * Separate-process writer for same-file race regression.
 * Invoked via: tsx write-lock-multiproc-worker.ts <filePath> <rounds> <outJson> <readyPath> <goPath>
 *
 * Barrier protocol:
 * 1. Child finishes imports + SDK init, then writes READY to readyPath.
 * 2. Child waits until goPath exists.
 * 3. Parent waits for READY, prepares its own jobs, writes goPath, then both race.
 *
 * Capture events use globally distinct idempotency keys (side+round+slot),
 * never process-local fixture counters.
 */
import { existsSync, writeFileSync } from "node:fs";

import { createDeterministicInferenceCallbacks, initLhc, retrieval, type MessageEventInput } from "../../src/index.js";

const filePath = process.argv[2];
const rounds = Number(process.argv[3] ?? "20");
const outPath = process.argv[4];
const readyPath = process.argv[5];
const goPath = process.argv[6];

if (!filePath || !outPath || !readyPath || !goPath || !Number.isFinite(rounds) || rounds < 1) {
  console.error("usage: write-lock-multiproc-worker.ts <filePath> <rounds> <outJson> <readyPath> <goPath>");
  process.exit(2);
}

function raceCaptureEvents(side: "child", round: number, userText: string, asstText: string): MessageEventInput[] {
  const base = { actor: "child-actor", harness: "multiproc-race" } as const;
  return [
    {
      eventKind: "user_prompt",
      idempotencyKey: `race-${side}-r${round}-user`,
      ...base,
      payload: { text: userText },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: `race-${side}-r${round}-asst`,
      ...base,
      payload: { text: asstText },
    },
    {
      eventKind: "turn_end",
      idempotencyKey: `race-${side}-r${round}-end`,
      ...base,
      payload: {},
    },
  ];
}

const sdk = initLhc({
  mode: "manual",
  inferenceCallbacks: createDeterministicInferenceCallbacks(),
});

// Child finished setup — signal READY, then wait for simultaneous release.
writeFileSync(readyPath, `READY pid=${process.pid}\n`, "utf8");
const waitStart = Date.now();
while (!existsSync(goPath)) {
  if (Date.now() - waitStart > 30_000) {
    console.error("child timeout waiting for go barrier");
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 5));
}

let fails = 0;
let locked = 0;
let successRounds = 0;
let skippedOutcomes = 0;
const surfaces: string[] = [];

const jobs: Promise<void>[] = [];
for (let i = 0; i < rounds; i += 1) {
  jobs.push(
    (async () => {
      const surface = `child-${i}`;
      const [ret, cap] = await Promise.all([
        retrieval.getTurns({ filePath }, ["t1"], { surface }),
        sdk.intakeStream.messageEvents({ filePath }, raceCaptureEvents("child", i, `c-${i}`, `ca-${i}`)),
      ]);
      if (!ret.ok || !cap.ok) {
        fails += 1;
        const reasons = [ret.ok ? "" : ret.error.reason, cap.ok ? "" : cap.error.reason].join(" ");
        if (/database is locked/i.test(reasons)) locked += 1;
        console.error(`child fail i=${i}: ${reasons}`);
        return;
      }
      const outcomes = cap.value.events.map((e) => e.outcome);
      const skipCount = outcomes.filter((o) => o === "skipped").length;
      if (skipCount > 0) {
        fails += 1;
        skippedOutcomes += skipCount;
        console.error(`child skip i=${i}: ${outcomes.join(",")}`);
        return;
      }
      if (outcomes.length !== 3 || outcomes.some((o) => o !== "recorded")) {
        fails += 1;
        console.error(`child unexpected outcomes i=${i}: ${outcomes.join(",")}`);
        return;
      }
      successRounds += 1;
      surfaces.push(surface);
    })(),
  );
}

await Promise.all(jobs);

writeFileSync(
  outPath,
  JSON.stringify(
    {
      fails,
      locked,
      rounds,
      successRounds,
      skippedOutcomes,
      surfaces,
      pid: process.pid,
    },
    null,
    2,
  ),
  "utf8",
);
process.exit(fails === 0 ? 0 : 1);
