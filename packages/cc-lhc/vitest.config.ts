import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    setupFiles: ["./test/setup-env.ts"],
    passWithNoTests: true,
    testTimeout: 15_000,
    env: {
      CC_LHC_HOME: join(tmpdir(), `cc-lhc-vitest-${process.pid}`),
      CC_LHC_IDENTITY_ADDON: join(
        dirname(fileURLToPath(import.meta.url)),
        "test",
        "fixtures",
        "stub-identity-addon.cjs",
      ),
    },
  },
});
