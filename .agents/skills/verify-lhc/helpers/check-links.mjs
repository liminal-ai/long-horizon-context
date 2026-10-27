#!/usr/bin/env node
// Link check: every relative markdown link and helpers/ path named in the
// skill and feature files must exist on disk.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [join(skillDir, "SKILL.md"), ...readdirSync(join(skillDir, "features")).filter((f) => f.endsWith(".md")).map((f) => join(skillDir, "features", f))];
let checked = 0;
const broken = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\]\((?!https?:|#)([^)\s]+)\)/g)) {
    checked += 1;
    const target = join(dirname(file), match[1].split("#")[0]);
    if (!existsSync(target)) broken.push(`${file}: ${match[1]}`);
  }
  for (const match of text.matchAll(/helpers\/[\w.-]+\.mjs/g)) {
    checked += 1;
    if (!existsSync(join(skillDir, match[0]))) broken.push(`${file}: ${match[0]}`);
  }
}
if (broken.length > 0) {
  console.error(`FAIL: broken links:\n${broken.join("\n")}`);
  process.exit(1);
}
console.log(`verify-lhc check-links: PASS (${checked} links across ${files.length} files)`);
