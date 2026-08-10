import { tmpdir } from "node:os";
import { join } from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    passWithNoTests: true,
    // No test may write lineage, descriptors, owners, recovery artifacts, or
    // wrapper warnings into the operator's production ~/.cc-lhc directory.
    // Individual tests may override this with their own temp home.
    env: {
      CC_LHC_HOME: join(tmpdir(), `cc-lhc-vitest-${process.pid}`),
    },
  },
});
