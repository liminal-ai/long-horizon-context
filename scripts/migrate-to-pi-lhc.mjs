#!/usr/bin/env node
// Offline one-shot migration: ~/.lhc + ~/.pi/agent → PI_LHC_HOME (~/.pi-lhc).
// Usage:
//   node scripts/migrate-to-pi-lhc.mjs [--dry-run] [--yes]
//     [--from <lhcDir>] [--to <home>] [--pi-agent <dir>]
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const backupScriptSrc = join(scriptsDir, "pi-lhc-backup.sh");

const AGENT_COPY_FILES = ["auth.json", "models.json", "settings.json", "trust.json"];
const AGENT_COPY_DIRS = ["extensions", "skills"];

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    dryRun: false,
    yes: false,
    from: undefined,
    to: undefined,
    piAgent: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes") out.yes = true;
    else if (a === "--from") {
      out.from = argv[++i];
      if (!out.from) die("missing value for --from");
    } else if (a === "--to") {
      out.to = argv[++i];
      if (!out.to) die("missing value for --to");
    } else if (a === "--pi-agent") {
      out.piAgent = argv[++i];
      if (!out.piAgent) die("missing value for --pi-agent");
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printUsage() {
  console.log(`Usage: node scripts/migrate-to-pi-lhc.mjs [options]
  --dry-run          print the full plan; change nothing
  --yes              execute the migration (required to write)
  --from <lhcDir>    source LHC home (default: ~/.lhc)
  --to <home>        destination pi-lhc home (default: $PI_LHC_HOME or ~/.pi-lhc)
  --pi-agent <dir>   PI agent dir to seed from (default: ~/.pi/agent)`);
}

function die(msg, code = 1) {
  console.error(`migrate-to-pi-lhc: ${msg}`);
  process.exit(code);
}

/** Match packages/pi-lhc/src/home.ts: empty-string env is unset. */
function resolveToHome(cliTo) {
  if (cliTo !== undefined) return resolve(cliTo);
  const override = process.env.PI_LHC_HOME;
  if (override !== undefined && override !== "") return resolve(override);
  return join(homedir(), ".pi-lhc");
}

function resolveFrom(cliFrom) {
  return resolve(cliFrom ?? join(homedir(), ".lhc"));
}

function resolvePiAgent(cliPiAgent) {
  return resolve(cliPiAgent ?? join(homedir(), ".pi", "agent"));
}

// ── Alive-process check ──────────────────────────────────────────────────────

/**
 * True when a process-list line looks like it is *executing* pi-lhc's bin
 * (a whitespace-separated argv token whose path ends with pi-lhc/dist/bin.js).
 * Plain-text mentions inside prompts/docs do not count.
 */
function isPiLhcProcessLine(line) {
  for (const raw of line.split(/\s+/)) {
    if (!raw) continue;
    const tok = raw.replace(/^['"]+|['"]+$/g, "");
    if (tok === "pi-lhc/dist/bin.js" || tok.endsWith("/pi-lhc/dist/bin.js")) {
      return true;
    }
  }
  return false;
}

function findAlivePiLhcProcesses() {
  let stdout;
  try {
    stdout = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
  } catch {
    // If ps is unavailable, refuse rather than migrate under an unknown process set.
    die("could not list processes (ps -axo command failed); refusing to migrate");
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && isPiLhcProcessLine(line));
}

function refuseIfPiLhcAlive() {
  const hits = findAlivePiLhcProcesses();
  if (hits.length === 0) return;
  console.error("migrate-to-pi-lhc: refusing to run while pi-lhc is alive:");
  for (const line of hits) console.error(`  ${line}`);
  console.error("Stop every pi-lhc session, then re-run.");
  process.exit(1);
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

function isNonEmptyDir(dir) {
  if (!existsSync(dir)) return false;
  if (!statSync(dir).isDirectory()) return true;
  return readdirSync(dir).length > 0;
}

function movePath(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(src, dest);
  } catch (err) {
    // Cross-device rename fails with EXDEV; fall back to copy + remove.
    if (err && typeof err === "object" && "code" in err && err.code === "EXDEV") {
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

function copyFileNoClobber(src, dest) {
  if (existsSync(dest)) return "kept";
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return "copied";
}

function copyDirNoClobber(src, dest) {
  if (!existsSync(src)) return [];
  const results = [];
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      // The *.bak* exclusion applies inside seeded dirs too, not just at the agent root.
      if (name.includes(".bak")) continue;
      const fromPath = join(from, name);
      const toPath = join(to, name);
      const st = statSync(fromPath);
      if (st.isDirectory()) {
        walk(fromPath, toPath);
      } else {
        const action = copyFileNoClobber(fromPath, toPath);
        results.push({ path: toPath, action, rel: relativeTo(dest, toPath) });
      }
    }
  };
  walk(src, dest);
  return results;
}

function relativeTo(root, full) {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

// ── Registry ─────────────────────────────────────────────────────────────────

function threadsPrefix(fromDir) {
  // Trailing sep so we match <from>/threads/... and not <from>/threads-old/...
  return join(fromDir, "threads") + sep;
}

function listRegistryRows(registryPath) {
  const db = new DatabaseSync(registryPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT thread_id, file_path, title, cwd, created_at FROM threads ORDER BY created_at, rowid")
      .all();
    return rows.map((r) => ({
      threadId: String(r.thread_id),
      filePath: String(r.file_path),
    }));
  } finally {
    db.close();
  }
}

function planRowRewrites(rows, fromDir, toDir) {
  const prefix = threadsPrefix(fromDir);
  const toThreads = join(toDir, "threads");
  const rewrites = [];
  const skips = [];
  for (const row of rows) {
    if (row.filePath.startsWith(prefix)) {
      const name = basename(row.filePath);
      rewrites.push({
        threadId: row.threadId,
        from: row.filePath,
        to: join(toThreads, name),
      });
    } else {
      skips.push(row);
    }
  }
  return { rewrites, skips };
}

function checkpointRegistry(registryPath) {
  const db = new DatabaseSync(registryPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}

function applyRowRewrites(registryPath, rewrites) {
  const db = new DatabaseSync(registryPath);
  try {
    const stmt = db.prepare("UPDATE threads SET file_path = ? WHERE thread_id = ?");
    db.exec("BEGIN;");
    try {
      for (const r of rewrites) {
        stmt.run(r.to, r.threadId);
      }
      db.exec("COMMIT;");
    } catch (cause) {
      db.exec("ROLLBACK;");
      throw cause;
    }
  } finally {
    db.close();
  }
}

// ── Plan / summary printing ──────────────────────────────────────────────────

function buildPlan(fromDir, toDir, piAgentDir) {
  const sourceRegistry = join(fromDir, "registry.sqlite");
  if (!existsSync(sourceRegistry)) {
    die(`source registry missing: ${sourceRegistry}`);
  }

  const destRegistry = join(toDir, "registry.sqlite");
  const destThreads = join(toDir, "threads");
  const destGit = join(toDir, ".git");

  const blockers = [];
  if (existsSync(destRegistry)) blockers.push(`destination already has registry.sqlite: ${destRegistry}`);
  if (isNonEmptyDir(destThreads)) blockers.push(`destination already has non-empty threads/: ${destThreads}`);
  if (existsSync(destGit)) blockers.push(`destination already has .git: ${destGit}`);
  if (blockers.length > 0) {
    for (const b of blockers) console.error(`migrate-to-pi-lhc: ${b}`);
    die("destination looks already migrated; refusing to merge");
  }

  if (!existsSync(backupScriptSrc)) {
    die(`repo backup script missing: ${backupScriptSrc}`);
  }

  const rows = listRegistryRows(sourceRegistry);
  const { rewrites, skips } = planRowRewrites(rows, fromDir, toDir);

  const sourceThreads = join(fromDir, "threads");
  let threadFileCount = 0;
  if (existsSync(sourceThreads) && statSync(sourceThreads).isDirectory()) {
    threadFileCount = readdirSync(sourceThreads).length;
  }

  const envSrc = join(fromDir, ".env");
  const hasEnv = existsSync(envSrc);

  const agentActions = planAgentSeed(piAgentDir, join(toDir, "pi", "agent"));

  const hasGit = existsSync(join(fromDir, ".git"));
  const hasGitignore = existsSync(join(fromDir, ".gitignore"));

  return {
    fromDir,
    toDir,
    piAgentDir,
    sourceRegistry,
    rewrites,
    skips,
    threadFileCount,
    hasEnv,
    agentActions,
    hasGit,
    hasGitignore,
  };
}

function planAgentSeed(piAgentDir, destAgentDir) {
  /** @type {{ kind: "file"|"dir", name: string, src: string, dest: string, action: "copy"|"keep"|"absent" }[]} */
  const actions = [];
  for (const name of AGENT_COPY_FILES) {
    const src = join(piAgentDir, name);
    const dest = join(destAgentDir, name);
    if (!existsSync(src)) {
      actions.push({ kind: "file", name, src, dest, action: "absent" });
    } else if (existsSync(dest)) {
      actions.push({ kind: "file", name, src, dest, action: "keep" });
    } else {
      actions.push({ kind: "file", name, src, dest, action: "copy" });
    }
  }
  for (const name of AGENT_COPY_DIRS) {
    const src = join(piAgentDir, name);
    const dest = join(destAgentDir, name);
    // Per-file no-clobber is applied at execute time; plan notes the dir will seed.
    actions.push({ kind: "dir", name, src, dest, action: existsSync(src) ? "copy" : "absent" });
  }
  return actions;
}

function printPlanHeader(plan, mode) {
  console.log(`migrate-to-pi-lhc: ${mode}`);
  console.log(`  from:     ${plan.fromDir}`);
  console.log(`  to:       ${plan.toDir}`);
  console.log(`  pi-agent: ${plan.piAgentDir}`);
}

function printFullPlan(plan) {
  printPlanHeader(plan, "plan");
  console.log("  steps:");
  console.log(`    create destination home: ${plan.toDir}`);
  console.log(`    checkpoint + move registry.sqlite → ${join(plan.toDir, "registry.sqlite")}`);
  console.log(`    move threads/ (${plan.threadFileCount} entries) → ${join(plan.toDir, "threads")}`);
  console.log(`    rewrite registry rows (${plan.rewrites.length} rewrite, ${plan.skips.length} skip):`);
  for (const r of plan.rewrites) {
    console.log(`      rewrite ${r.threadId} ${r.from} → ${r.to}`);
  }
  for (const s of plan.skips) {
    console.log(`      skip ${s.threadId} ${s.filePath}`);
  }
  if (plan.hasEnv) {
    console.log(`    copy .env → ${join(plan.toDir, ".env")}`);
  } else {
    console.log("    .env: absent at source (skip)");
  }
  console.log("    seed pi/agent/:");
  for (const a of plan.agentActions) {
    if (a.action === "absent") console.log(`      absent ${a.name}`);
    else if (a.action === "keep") console.log(`      keep ${a.name} (already at destination)`);
    else console.log(`      copy ${a.name}`);
  }
  if (plan.hasGit) console.log(`    move .git → ${join(plan.toDir, ".git")}`);
  else console.log("    .git: absent at source (skip)");
  if (plan.hasGitignore) console.log(`    move .gitignore → ${join(plan.toDir, ".gitignore")}`);
  else console.log("    .gitignore: absent at source (skip)");
  console.log(`    install backup.sh from ${backupScriptSrc}`);
  console.log(`    leave leftovers in ${plan.fromDir} as rollback`);
}

// ── Execute ──────────────────────────────────────────────────────────────────

function execute(plan) {
  printPlanHeader(plan, "running");
  const { fromDir, toDir, piAgentDir } = plan;

  // 1. Create destination home
  mkdirSync(toDir, { recursive: true });
  console.log(`  created destination: ${toDir}`);

  // 2. Checkpoint + move registry
  checkpointRegistry(plan.sourceRegistry);
  const destRegistry = join(toDir, "registry.sqlite");
  movePath(plan.sourceRegistry, destRegistry);
  console.log(`  moved registry.sqlite → ${destRegistry}`);

  // 3. Move threads/
  const sourceThreads = join(fromDir, "threads");
  const destThreads = join(toDir, "threads");
  if (existsSync(sourceThreads)) {
    movePath(sourceThreads, destThreads);
    console.log(`  moved threads/ (${plan.threadFileCount} entries) → ${destThreads}`);
  } else {
    console.log("  threads/: absent at source (skip)");
  }

  // 4. Rewrite registry rows
  applyRowRewrites(destRegistry, plan.rewrites);
  for (const r of plan.rewrites) {
    console.log(`  rewrite ${r.threadId} ${r.from} → ${r.to}`);
  }
  for (const s of plan.skips) {
    console.log(`  skip ${s.threadId} ${s.filePath}`);
  }

  // 5. Copy .env
  let envCopied = false;
  const envSrc = join(fromDir, ".env");
  if (existsSync(envSrc)) {
    copyFileSync(envSrc, join(toDir, ".env"));
    envCopied = true;
    console.log(`  copied .env → ${join(toDir, ".env")}`);
  }

  // 6. Seed pi/agent/
  const destAgent = join(toDir, "pi", "agent");
  mkdirSync(destAgent, { recursive: true });
  const agentSeeded = [];
  const agentKept = [];
  for (const name of AGENT_COPY_FILES) {
    const src = join(piAgentDir, name);
    if (!existsSync(src)) continue;
    const dest = join(destAgent, name);
    const action = copyFileNoClobber(src, dest);
    if (action === "kept") {
      agentKept.push(name);
      console.log(`  keep agent file ${name}`);
    } else {
      agentSeeded.push(name);
      console.log(`  seeded agent file ${name}`);
    }
  }
  for (const name of AGENT_COPY_DIRS) {
    const src = join(piAgentDir, name);
    if (!existsSync(src)) continue;
    const dest = join(destAgent, name);
    const results = copyDirNoClobber(src, dest);
    for (const r of results) {
      const label = `${name}/${r.rel}`;
      if (r.action === "kept") {
        agentKept.push(label);
        console.log(`  keep agent file ${label}`);
      } else {
        agentSeeded.push(label);
        console.log(`  seeded agent file ${label}`);
      }
    }
  }

  // 7. Move snapshot rail + install backup.sh from repo
  let railMoved = false;
  const gitSrc = join(fromDir, ".git");
  if (existsSync(gitSrc)) {
    movePath(gitSrc, join(toDir, ".git"));
    railMoved = true;
    console.log(`  moved .git → ${join(toDir, ".git")}`);
  }
  const giSrc = join(fromDir, ".gitignore");
  if (existsSync(giSrc)) {
    movePath(giSrc, join(toDir, ".gitignore"));
    railMoved = true;
    console.log(`  moved .gitignore → ${join(toDir, ".gitignore")}`);
  }
  const backupDest = join(toDir, "backup.sh");
  copyFileSync(backupScriptSrc, backupDest);
  chmodSync(backupDest, 0o755);
  console.log(`  installed backup.sh from repo → ${backupDest}`);

  // 8. Summary
  console.log("migrate-to-pi-lhc: summary");
  console.log(`  rows rewritten: ${plan.rewrites.length}`);
  console.log(`  rows skipped:   ${plan.skips.length}`);
  for (const s of plan.skips) {
    console.log(`    skip ${s.threadId} ${s.filePath}`);
  }
  console.log(`  thread files moved: ${plan.threadFileCount}`);
  console.log(`  .env: ${envCopied ? "copied" : "absent"}`);
  console.log(`  agent files seeded: ${agentSeeded.length > 0 ? agentSeeded.join(", ") : "(none)"}`);
  console.log(`  agent files kept:   ${agentKept.length > 0 ? agentKept.join(", ") : "(none)"}`);
  console.log(`  snapshot rail moved: ${railMoved ? "yes" : "no"}`);
  console.log(`  backup.sh installed from repo`);
  console.log(
    `  leftovers remain in ${fromDir} as rollback (old backup.sh, cc-sessions.json, skipped-row targets, etc.; cc-sessions.json is deliberately not migrated)`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  refuseIfPiLhcAlive();

  const fromDir = resolveFrom(args.from);
  const toDir = resolveToHome(args.to);
  const piAgentDir = resolvePiAgent(args.piAgent);

  const plan = buildPlan(fromDir, toDir, piAgentDir);

  if (args.dryRun) {
    printFullPlan(plan);
    console.log("migrate-to-pi-lhc: dry-run complete (no changes)");
    process.exit(0);
  }

  if (!args.yes) {
    printPlanHeader(plan, "plan (not executed)");
    console.log(`  rows: ${plan.rewrites.length} rewrite, ${plan.skips.length} skip`);
    console.log(`  thread entries: ${plan.threadFileCount}`);
    console.log("migrate-to-pi-lhc: pass --yes to run (or --dry-run for the full plan)");
    process.exit(2);
  }

  execute(plan);
}

main();
