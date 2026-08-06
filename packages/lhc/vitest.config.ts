import { configDefaults, defineConfig } from "vitest/config";

// One default tier, no network (Epic 05 Flow 6). The real-inference suite is
// env-gated inside the runner (OPENROUTER_API_KEY) and self-reports
// ran/not-ran; there is no script-gated tier since the spawned-process CLI
// suite retired.
export default defineConfig({
  test: {
    // Deterministic-pipeline tests are fast alone but share CPU with three
    // sibling suites under workspace-recursive runs; vitest's 5s default
    // intermittently times out the heavier fixture tests there.
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    passWithNoTests: true,
  },
});
