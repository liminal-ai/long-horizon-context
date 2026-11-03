import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "plugin");

// Keep .claude-plugin/types: Claude Code lays it there when it loads the plugin, and typecheck-mod.mjs reads it.
for (const built of ["hooks", "sidecar", "test", "types", ".claude-plugin/plugin.json"]) {
  rmSync(join(out, built), { recursive: true, force: true });
}
mkdirSync(join(out, ".claude-plugin"), { recursive: true });

await build({
  entryPoints: [join(root, "mod", "hooks", "register.ts")],
  outfile: join(out, "hooks", "register.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  external: ["claude-code"],
  jsx: "transform",
  jsxFactory: "h",
  jsxFragment: "Fragment",
  logLevel: "warning",
});
// claude plugin validate reads the module's source: it wants `register` exported where it is declared.
const modFile = join(out, "hooks", "register.js");
const bundled = readFileSync(modFile, "utf8");
const exported = bundled
  .replace(/^var register = /m, "export const register = ")
  .replace(/export \{\n {2}register\n\};\n$/, "");
if (exported === bundled || exported.includes("export {")) throw new Error("build: could not export register in place");
writeFileSync(modFile, exported);

await build({
  entryPoints: [join(root, "sidecar", "src", "main.ts")],
  outfile: join(out, "sidecar", "main.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  logLevel: "warning",
});

for (const file of [".claude-plugin/plugin.json", "hooks/hooks.json", "types/index.d.ts"]) {
  cpSync(join(root, "mod", file), join(out, file));
}
for (const test of ["mod.test.ts", "panel.test.tsx"]) cpSync(join(root, "test", test), join(out, "test", test));
console.log(`built ${out}`);
