import { configDefaults, defineConfig } from "vitest/config";

// One default tier, no network. Epic 1 is observe-only and every test runs
// against synthetic PI events / recorded corpora and a real temp SQLite
// thread; the only external edge mocked is the host ModelCall (test fixture).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    passWithNoTests: true,
  },
});
