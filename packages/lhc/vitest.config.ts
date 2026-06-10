import { configDefaults, defineConfig } from "vitest/config";

// The CLI process-boundary suite spawns dist/cli.js and needs a build
// artifact, so it runs under verify-all only (LHC_PROCESS_SUITE=1). Its
// absence from plain verify is announced by the verify script, never silent.
const includeProcessSuite = process.env["LHC_PROCESS_SUITE"] === "1";

export default defineConfig({
  test: {
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
          ]),
    ],
    passWithNoTests: true,
  },
});
