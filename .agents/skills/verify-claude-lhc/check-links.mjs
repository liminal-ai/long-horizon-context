#!/usr/bin/env node
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const failures = [];
const mdFiles = [join(HERE, "SKILL.md"), join(HERE, "features", "README.md"),
  ...readdirSync(join(HERE, "features")).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => join(HERE, "features", f))];

const skill = readFileSync(join(HERE, "SKILL.md"), "utf8");
if (!/^---\nname: verify-claude-lhc\n/m.test(skill)) failures.push("SKILL.md frontmatter must start with name: verify-claude-lhc");
for (const section of ["Launch", "Doctor", "Drive", "Evidence", "Cleanup", "Helpers"]) {
  if (!new RegExp(`^## ${section}\\b`, "m").test(skill)) failures.push(`SKILL.md missing ## ${section}`);
}
for (const file of mdFiles.slice(2)) {
  const body = readFileSync(file, "utf8");
  for (const h2 of ["## Sub-features", "## How to get to it (user POV)", "## Driving it with the harness", "## Gotchas"]) {
    if (!body.includes(h2)) failures.push(`${file.split("/").pop()} missing ${h2}`);
  }
}
for (const file of mdFiles) {
  const body = readFileSync(file, "utf8");
  for (const [, target] of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^(https?:|#|mailto:)/.test(target)) continue;
    const path = target.split("#")[0];
    try { accessSync(resolve(dirname(file), path)); }
    catch { failures.push(`${file.split("/").slice(-2).join("/")}: broken link ${target}`); }
  }
}
for (const helper of ["doctor.sh", "drive.mjs", "cleanup.sh", "check-links.mjs"]) {
  try { accessSync(join(HERE, helper), constants.X_OK); }
  catch { failures.push(`helper not executable: ${helper}`); }
  if (!skill.includes(helper)) failures.push(`SKILL.md does not name helper ${helper}`);
}
if (failures.length > 0) {
  for (const f of failures) console.log(`check-links: FAIL ${f}`);
  console.log("VERIFY-CLAUDE-LHC check-links: FAIL");
  process.exit(1);
}
console.log(`check-links: ${mdFiles.length} markdown files, sections + links + executables ok`);
console.log("VERIFY-CLAUDE-LHC check-links: PASS");
