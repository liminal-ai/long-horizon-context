import { configDefaults, defineConfig } from "vitest/config";

// The CLI process-boundary suite spawns dist/cli.js and needs a build
// artifact, so it runs under verify-all only (LHC_PROCESS_SUITE=1). Its
// absence from plain verify is announced by the verify script, never silent.
const includeProcessSuite = process.env["LHC_PROCESS_SUITE"] === "1";

export default defineConfig({
  test: {
    // Process-suite tests spawn dist/cli.js subprocesses; under verify-all the
    // whole suite runs concurrently and per-spawn latency climbs with CPU
    // contention, so they need headroom past Vitest's 5s default. The editable
    // process files already set explicit per-test timeouts (30s floor; 60s/120s
    // for compaction-heavy legs, which override this global). This floor covers
    // the ones that don't — notably the hash-locked cli-process-report-repair —
    // without touching the locked test. Plain verify keeps the tight 5s default
    // so the in-process unit tests stay fast and a genuine hang surfaces quickly.
    ...(includeProcessSuite ? { testTimeout: 30000, hookTimeout: 30000 } : {}),
    include: ["test/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      ...(includeProcessSuite
        ? []
        : [
            "test/cli-process.test.ts",
            "test/cli-process-intake.test.ts",
            "test/cli-process-projection.test.ts",
            "test/cli-process-turns.test.ts",
            "test/cli-process-work-queue.test.ts",
            "test/cli-process-work.test.ts",
            "test/cli-process-report-repair.test.ts",
            "test/cli-process-mutations.test.ts",
            "test/cli-process-mutations-delete.test.ts",
            "test/cli-process-fix.test.ts",
            "test/cli-process-view.test.ts",
            "test/cli-process-inspect.test.ts",
          ]),
    ],
    passWithNoTests: true,
  },
});
