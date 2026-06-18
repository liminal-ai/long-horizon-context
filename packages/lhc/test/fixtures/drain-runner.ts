// Spawnable drain runner for the process-boundary suite (TC-1.3 / TC-1.4).
// Argument: one JSON config — { threadPath, leaseMs, holdMs, holdFrom }.
// It assembles a real SDK (manual mode), registers the test work handlers
// with a marker/hold protocol, and drains the thread:
//   - prints `HANDLER_START <n> <workItemId>` when the nth handler begins —
//     by drain mechanics that means item n's claim committed and item n-1's
//     completion landed (the reclaim window for a kill is open);
//   - from item `holdFrom` on, sleeps `holdMs` inside the handler before the
//     model call, keeping that item claimed-and-running while the parent
//     kills this process (TC-1.3) or drains from a second process (TC-1.4);
//   - prints `DRAIN_DONE <report JSON>` if it survives to the end.
import process from "node:process";
import { initLhc } from "../../src/index.js";
import { createInferenceCallbacksDouble } from "./inference-callbacks-double.js";
import { registerTestWorkHandlers } from "./work-handlers.js";

interface RunnerConfig {
  threadPath: string;
  leaseMs: number;
  holdMs: number;
  holdFrom: number; // 1-based handler-start index the hold applies from
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error("drain-runner: missing JSON config argument");
  const config = JSON.parse(raw) as RunnerConfig;

  const double = createInferenceCallbacksDouble();
  const sdk = initLhc({
    inferenceCallbacks: double,
    mode: "manual",
    lease: { durationMs: config.leaseMs },
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
  });
  let started = 0;
  registerTestWorkHandlers(sdk, double, {
    onHandlerStart: async (item) => {
      started += 1;
      process.stdout.write(`HANDLER_START ${started} ${item.workItemId}\n`);
      if (started >= config.holdFrom) await sleep(config.holdMs);
    },
  });

  const report = await sdk.work.drain({ filePath: config.threadPath });
  process.stdout.write(`DRAIN_DONE ${JSON.stringify(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((cause: unknown) => {
  process.stderr.write(`drain-runner failed: ${String(cause)}\n`);
  process.exit(1);
});
