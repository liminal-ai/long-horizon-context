import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      // Deterministic identity addon for suites that run production-default
      // code paths (wrapper run(), session-owner defaults, retrieval
      // subprocesses) without requiring a C toolchain. Uses the documented
      // CC_LHC_IDENTITY_ADDON loader seam; the real compiled addon is
      // exercised by test/runtime/native-identity.test.ts, which bypasses
      // this override via loader seams.
      CC_LHC_IDENTITY_ADDON: join(
        dirname(fileURLToPath(import.meta.url)),
        "test",
        "fixtures",
        "stub-identity-addon.cjs",
      ),
    },
  },
});
