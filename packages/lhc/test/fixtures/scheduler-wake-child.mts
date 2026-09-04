// Child process for the scheduler wake-reference regressions (LIM-113).
// Loop-liveness semantics (exit 13 vs clean exit) can only be observed at the
// process boundary, so each scenario runs in its own child:
//
//   waiter-before-arm  — drainSettled awaited while the first pass is still
//                        running; the pass stops on an unexpired foreign claim
//                        and arms the wake WITH a waiter present. The wake must
//                        stay referenced; the waiter settles after expiry.
//   waiter-after-arm   — the pass finishes and arms an unreferenced idle wake
//                        first; drainSettled then refs it. Same settlement.
//   idle-unobserved    — wake armed for a far-future expiry, nobody waits; the
//                        process must exit promptly (wake stays unreferenced).
//
// Prints SETTLED / IDLE-EXIT markers; the parent asserts markers, exit code,
// and duration.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLhc, threads } from "../../src/index.js";
import { createInferenceCallbacksDouble, registerTestWorkHandlers, validEvent } from "./index.js";

const scenario = process.argv[2];
if (!["waiter-before-arm", "waiter-after-arm", "idle-unobserved"].includes(scenario ?? "")) {
  console.error(`unknown scenario: ${String(scenario)}`);
  process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function claimHeadWorkItem(filePath: string, expiresAt: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("BEGIN IMMEDIATE;");
    const changed = db
      .prepare(
        `UPDATE work_item
         SET status = 'claimed',
             claimed_at = ?,
             claim_expires_at = ?
         WHERE work_item_id = (
           SELECT work_item_id FROM work_item
           WHERE status IN ('queued', 'claimed')
           ORDER BY rowid LIMIT 1
         )`,
      )
      .run(new Date(Date.parse(expiresAt) - 1000).toISOString(), expiresAt);
    if (Number(changed.changes) !== 1) throw new Error("expected to claim exactly one work item");
    db.exec("COMMIT;");
  } finally {
    db.close();
  }
}

const dir = mkdtempSync(join(tmpdir(), "lhc-wake-child-"));
const filePath = join(dir, "t.sqlite");

// 1. Queue real background work without processing it (manual mode).
const manualDouble = createInferenceCallbacksDouble();
const manual = initLhc({ mode: "manual", inferenceCallbacks: manualDouble });
registerTestWorkHandlers(manual, manualDouble);
const created = await threads.newThread({ filePath, registryPath: join(dir, "registry.sqlite") });
if (!created.ok) {
  console.error(`thread create failed: ${created.error.reason}`);
  process.exit(2);
}
const queued = await manual.intakeStream.messageEvents({ filePath }, [validEvent("user_prompt")]);
if (!queued.ok) {
  console.error(`queue failed: ${queued.error.reason}`);
  process.exit(2);
}

// 2. Foreign unexpired claim on the head item.
const claimMs = scenario === "idle-unobserved" ? 60_000 : 1_500;
claimHeadWorkItem(filePath, new Date(Date.now() + claimMs).toISOString());

// 3. Background SDK; drive the scheduler seam DIRECTLY so the timing is
//    deterministic: touch schedules the catch-up pass synchronously
//    (running=true before touch returns), and the pass stops on the foreign
//    claim ("in_flight"), arming the claim-expiry wake.
const bgDouble = createInferenceCallbacksDouble();
const bg = initLhc({ mode: "background", inferenceCallbacks: bgDouble });
registerTestWorkHandlers(bg, bgDouble);
const threadId = created.value.threadId;
const opened = bg.threads.openThreadDatabase(filePath);
if (!opened.ok) {
  console.error(`open failed: ${opened.error.reason}`);
  process.exit(2);
}
bg.scheduler.touch(filePath, opened.value);

if (scenario === "waiter-before-arm") {
  // The pass is running right now: this waiter is present when armWake runs.
  const settled = bg.scheduler.drainSettled(threadId);
  if (bg.scheduler.testPassCount(threadId) > 1) {
    console.error("pass already finished — waiter-before-arm window missed");
    process.exit(2);
  }
  await settled;
  console.log(`SETTLED pass=${bg.scheduler.testPassCount(threadId)}`);
} else if (scenario === "waiter-after-arm") {
  // Let the pass finish and arm the idle (unreferenced) wake first.
  await sleep(500);
  await bg.scheduler.drainSettled(threadId);
  console.log(`SETTLED pass=${bg.scheduler.testPassCount(threadId)}`);
} else {
  // Nobody waits. The armed 60s wake must not keep the process alive.
  await sleep(300);
  console.log("IDLE-EXIT");
}
