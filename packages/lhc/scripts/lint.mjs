#!/usr/bin/env node
// Zero-dependency lint. ESLint installation was not available in this
// environment, so the lint gate enforces a minimal in-repo rule set:
//   - no `var` declarations
//   - no `any` escapes (`: any`, `as any`, `<any>`)
//   - no `console.` usage in src/
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function collectTsFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const srcFiles = collectTsFiles(path.join(pkgRoot, "src"));
const testFiles = collectTsFiles(path.join(pkgRoot, "test"));
const problems = [];

const rules = [
  { re: /(?<![\w$.])var\s+[A-Za-z_$]/, message: "no `var` declarations", srcOnly: false },
  { re: /:\s*any\b|as\s+any\b|<any>/, message: "no `any` escapes", srcOnly: false },
  { re: /(?<![\w$.])console\./, message: "no console usage in src/", srcOnly: true },
];

for (const file of [...srcFiles, ...testFiles]) {
  const isSrc = srcFiles.includes(file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const rule of rules) {
      if (rule.srcOnly && !isSrc) continue;
      if (rule.re.test(code)) {
        problems.push(`${path.relative(pkgRoot, file)}:${i + 1} ${rule.message}`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error("lint FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`lint: OK (${srcFiles.length + testFiles.length} files)`);
