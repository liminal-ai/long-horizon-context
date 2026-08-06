import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts", "src/**/*.test.ts", "test/**/*.test.ts"],
    passWithNoTests: false,
    // convex-test spins a full runtime per test; under workspace-recursive
    // runs the CPU contention pushes single tests past vitest's 5s default.
    testTimeout: 30_000,
  },
});
