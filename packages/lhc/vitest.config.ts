import { configDefaults, defineConfig } from "vitest/config";

// One default tier, no network (Epic 05 Flow 6). The real-inference suite is
// env-gated inside the runner (LHC_OPENROUTER_KEY) and self-reports
// ran/not-ran; there is no script-gated tier since the spawned-process CLI
// suite retired.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    passWithNoTests: true,
  },
});
