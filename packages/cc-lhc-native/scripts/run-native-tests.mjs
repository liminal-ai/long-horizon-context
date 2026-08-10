// Build the addon from source, then run the full test suite with the
// compiled-addon suites made mandatory (CC_LHC_NATIVE_REQUIRE_ADDON=1).
//
// Deliberately portable: no shell `rm -rf`, no POSIX inline env assignment,
// no nested `pnpm run` (this repo tracks a pnpm pre-run crash). Tools are
// resolved through Node's own resolver and spawned as node processes, so the
// script behaves identically under native Windows cmd, macOS, and Linux.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const resolve = createRequire(join(root, "package.json")).resolve;

function run(label, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) {
    console.error(`cc-lhc-native: ${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`cc-lhc-native: ${label} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const nodeGyp = resolve("node-gyp/bin/node-gyp.js");
run("node-gyp rebuild", [nodeGyp, "rebuild"]);

const vitestPkgPath = resolve("vitest/package.json");
const vitestPkg = createRequire(vitestPkgPath)("./package.json");
const vitestBin = join(dirname(vitestPkgPath), vitestPkg.bin.vitest);
run("vitest run", [vitestBin, "run"], { CC_LHC_NATIVE_REQUIRE_ADDON: "1" });
