import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
  },
});
