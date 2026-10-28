#!/usr/bin/env node
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
let failures = 0;
const ok = (m) => console.log(`PASS: ${m}`);
const bad = (m) => { console.log(`FAIL: ${m}`); failures++; };

function mdFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? mdFiles(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []);
}

const files = mdFiles(skillDir);
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const abs = resolve(dirname(file), decodeURIComponent(target));
    existsSync(abs) ? ok(`${file.slice(skillDir.length + 1)} -> ${target}`) : bad(`${file} broken link: ${target}`);
  }
}

const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
/^---\nname: verify-cc-lhc\n/.test(skill) ? ok("SKILL.md frontmatter name") : bad("SKILL.md frontmatter name missing");
for (const s of ["Launch", "Doctor", "Drive", "Evidence", "Cleanup", "Helpers"]) {
  new RegExp(`^## ${s}\\b`, "m").test(skill) ? ok(`SKILL.md section: ${s}`) : bad(`SKILL.md missing section: ${s}`);
}
for (const m of skill.matchAll(/helpers\/([A-Za-z0-9._-]+)/g)) {
  const p = join(skillDir, "helpers", m[1]);
  if (!existsSync(p)) { bad(`SKILL.md names missing helper helpers/${m[1]}`); continue; }
  try { accessSync(p, constants.X_OK); ok(`helper executable: helpers/${m[1]}`); }
  catch { bad(`helper not executable: helpers/${m[1]}`); }
}

const featDir = join(skillDir, "features");
for (const f of readdirSync(featDir).filter((n) => n.endsWith(".md") && n !== "README.md")) {
  const text = readFileSync(join(featDir, f), "utf8");
  for (const h of ["## Sub-features", "## How to get to it (user POV)", "## Driving it with", "## Gotchas"]) {
    text.includes(h) ? ok(`${f}: ${h}`) : bad(`${f} missing H2: ${h}`);
  }
}

console.log(failures === 0 ? "VERIFY-CC-LHC link-check: PASS" : `VERIFY-CC-LHC link-check: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
