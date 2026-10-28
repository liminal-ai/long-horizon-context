import process from "node:process";
import { initLhc } from "../../src/index.js";
import { createInferenceCallbacksDouble } from "./inference-callbacks-double.js";
import { registerTestWorkHandlers } from "./work-handlers.js";

interface RunnerConfig {
  threadPath: string;
  leaseMs: number;
  holdMs: number;
  holdFrom: number;
  exitAfterMs?: number;
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
    tokenFamily: "o200k",
    inferenceCallbacks: double,
    mode: "manual",
    lease: { durationMs: config.leaseMs },
  });
  let started = 0;
  registerTestWorkHandlers(sdk, double, {
    onHandlerStart: async (item) => {
      started += 1;
      process.stdout.write(`HANDLER_START ${started} ${item.workItemId}\n`);
      if (started >= config.holdFrom) {
        if (config.exitAfterMs !== undefined) {
          setTimeout(() => {
            process.stdout.write("CLEAN_EXIT\n");
            process.exit(0);
          }, config.exitAfterMs);
        }
        await sleep(config.holdMs);
      }
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
