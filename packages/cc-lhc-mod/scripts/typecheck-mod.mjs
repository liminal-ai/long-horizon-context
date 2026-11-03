import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.CLAUDE_CODE_TYPES,
  join(root, "dist", "plugin", ".claude-plugin", "types", "claude-code", "index.d.ts"),
].filter((path) => path !== undefined && path !== "");
const types = candidates.find((path) => existsSync(path));
if (types === undefined) {
  console.log("cc-lhc-mod: SKIP mod typecheck, no claude-code.d.ts (set CLAUDE_CODE_TYPES or load dist/plugin once)");
  process.exit(0);
}

const configDir = join(root, "node_modules", ".cache", "cc-lhc-mod");
mkdirSync(configDir, { recursive: true });
const config = join(configDir, "tsconfig.mod.json");
writeFileSync(
  config,
  JSON.stringify({
    compilerOptions: {
      target: "es2023",
      lib: ["es2023"],
      types: [],
      module: "esnext",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      strict: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
    },
    files: [types],
    include: [join(root, "mod"), join(root, "src"), join(root, "test", "mod.test.ts")],
  }),
);
console.log(`cc-lhc-mod: mod typecheck against ${types}`);
execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", config], { stdio: "inherit" });
