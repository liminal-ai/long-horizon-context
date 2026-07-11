// Spawns scripts/migrate-to-pi-lhc.mjs against fixture homes in temp dirs.
// Never touches the real ~/.lhc, ~/.pi, or ~/.pi-lhc.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");
const migrateScript = join(repoRoot, "scripts", "migrate-to-pi-lhc.mjs");
const backupScript = join(repoRoot, "scripts", "pi-lhc-backup.sh");

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  // Path edge: include a space and a dot segment in the fixture root.
  const parent = mkdtempSync(join(tmpdir(), `${prefix}.edge `));
  temps.push(parent);
  return parent;
}

/**
 * Hermetic process table for the migrate script's alive-check.
 * Prepends a stub `ps` so host dogfood sessions don't fail fixture runs.
 */
function envWithFakePs(psStdout: string): NodeJS.ProcessEnv {
  const binDir = tempDir("fake-ps-bin-");
  const psPath = join(binDir, "ps");
  // Ignore real ps args; emit the scripted process list.
  writeFileSync(psPath, `#!/bin/sh\ncat <<'EOF'\n${psStdout}\nEOF\n`);
  chmodSync(psPath, 0o755);
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
}

const CLEAN_PS = "COMMAND\n/bin/zsh\n";
const ALIVE_PS = "COMMAND\n/bin/zsh\nnode /tmp/fixture/packages/pi-lhc/dist/bin.js --lhc-thread th_test\n";

function writeRegistry(
  registryPath: string,
  rows: Array<{ threadId: string; filePath: string; title?: string; cwd?: string }>,
): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  const db = new DatabaseSync(registryPath);
  try {
    db.exec(`CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL
    );`);
    const stmt = db.prepare(
      "INSERT INTO threads (thread_id, file_path, title, cwd, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    let i = 0;
    for (const row of rows) {
      i += 1;
      stmt.run(row.threadId, row.filePath, row.title ?? null, row.cwd ?? null, `2026-01-0${i}T00:00:00.000Z`);
    }
  } finally {
    db.close();
  }
}

function readRegistryRows(registryPath: string): Array<{ thread_id: string; file_path: string }> {
  const db = new DatabaseSync(registryPath, { readOnly: true });
  try {
    return db.prepare("SELECT thread_id, file_path FROM threads ORDER BY created_at, rowid").all() as Array<{
      thread_id: string;
      file_path: string;
    }>;
  } finally {
    db.close();
  }
}

interface Fixture {
  root: string;
  from: string;
  to: string;
  piAgent: string;
  liveThreadId: string;
  liveThreadName: string;
  deadThreadId: string;
  deadPath: string;
  commitMessage: string;
}

function buildFixture(opts: { seedDestAgent?: Record<string, string> } = {}): Fixture {
  const root = tempDir("migrate-fixture-");
  // Nested path with space + dot segment for path-edge coverage.
  const from = join(root, "src home", ".lhc");
  const to = join(root, "dest.home", "pi-lhc");
  const piAgent = join(root, "src home", ".pi", "agent");

  mkdirSync(join(from, "threads"), { recursive: true });
  mkdirSync(piAgent, { recursive: true });
  mkdirSync(to, { recursive: true });

  const liveThreadId = "th_live_aaaaaaaa";
  const liveThreadName = "aaaa.sqlite";
  const livePath = join(from, "threads", liveThreadName);
  // Dummy thread DB + WAL/SHM sidecars.
  writeFileSync(livePath, "sqlite-placeholder-live");
  writeFileSync(`${livePath}-wal`, "wal-bytes");
  writeFileSync(`${livePath}-shm`, "shm-bytes");

  const otherThreadId = "th_other_bbbbbbbb";
  const otherThreadName = "bbbb.sqlite";
  writeFileSync(join(from, "threads", otherThreadName), "sqlite-placeholder-other");

  const deadThreadId = "th_dead_cccccccc";
  const deadPath = "/var/folders/zz/dead_test_thread/T/th_dead.sqlite";

  writeRegistry(join(from, "registry.sqlite"), [
    { threadId: liveThreadId, filePath: livePath, title: "live" },
    { threadId: otherThreadId, filePath: join(from, "threads", otherThreadName), title: "other" },
    { threadId: deadThreadId, filePath: deadPath, title: "dead-temp" },
  ]);

  writeFileSync(join(from, ".env"), "OPENROUTER_API_KEY=fixture-key\n");
  writeFileSync(join(from, "backup.sh"), "#!/bin/zsh\necho old-backup\n");
  writeFileSync(join(from, "cc-sessions.json"), "{}\n");
  writeFileSync(join(from, ".gitignore"), ".env\n*.sqlite-wal\n*.sqlite-shm\n");

  // Snapshot rail: real git repo with one commit.
  const commitMessage = "fixture-rail-commit";
  execFileSync("git", ["init", "-b", "main"], { cwd: from, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: from, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: from, stdio: "pipe" });
  // Stage only gitignore so we have a commit; leave other files as working tree.
  execFileSync("git", ["add", ".gitignore"], { cwd: from, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", commitMessage], { cwd: from, stdio: "pipe" });

  // PI agent dir: full copy list + exclusions.
  writeFileSync(join(piAgent, "auth.json"), '{"auth":true}\n');
  writeFileSync(join(piAgent, "models.json"), '{"models":[]}\n');
  writeFileSync(join(piAgent, "settings.json"), '{"settings":true}\n');
  writeFileSync(join(piAgent, "trust.json"), '{"trust":true}\n');
  writeFileSync(join(piAgent, "settings.json.bak"), "should-not-copy\n");
  mkdirSync(join(piAgent, "extensions", "nested"), { recursive: true });
  writeFileSync(join(piAgent, "extensions", "demo.ts"), "export {}\n");
  writeFileSync(join(piAgent, "extensions", "demo.ts.bak"), "should-not-copy\n");
  writeFileSync(join(piAgent, "extensions", "nested", "secret.bak.2025"), "should-not-copy\n");
  mkdirSync(join(piAgent, "skills"), { recursive: true });
  writeFileSync(join(piAgent, "skills", "skill.md"), "# skill\n");
  mkdirSync(join(piAgent, "sessions"), { recursive: true });
  writeFileSync(join(piAgent, "sessions", "old.jsonl"), "session\n");
  mkdirSync(join(piAgent, "npm"), { recursive: true });
  writeFileSync(join(piAgent, "npm", "pkg.json"), "{}\n");
  mkdirSync(join(piAgent, "bin"), { recursive: true });
  writeFileSync(join(piAgent, "bin", "tool"), "#!/bin/sh\n");

  if (opts.seedDestAgent) {
    const destAgent = join(to, "pi", "agent");
    mkdirSync(destAgent, { recursive: true });
    for (const [name, content] of Object.entries(opts.seedDestAgent)) {
      writeFileSync(join(destAgent, name), content);
    }
  }

  return {
    root,
    from,
    to,
    piAgent,
    liveThreadId,
    liveThreadName,
    deadThreadId,
    deadPath,
    commitMessage,
  };
}

function runMigrate(
  args: string[],
  env: NodeJS.ProcessEnv = envWithFakePs(CLEAN_PS),
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [migrateScript, ...args], {
    encoding: "utf8",
    env,
    cwd: repoRoot,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("migrate-to-pi-lhc", () => {
  it("happy path end-to-end against fixture homes", () => {
    const fx = buildFixture();
    const result = runMigrate(["--from", fx.from, "--to", fx.to, "--pi-agent", fx.piAgent, "--yes"]);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain(`skip ${fx.deadThreadId} ${fx.deadPath}`);
    expect(result.stdout).toMatch(/rows rewritten:\s*2/);
    expect(result.stdout).toMatch(/rows skipped:\s*1/);

    // Registry moved + rewritten.
    expect(existsSync(join(fx.to, "registry.sqlite"))).toBe(true);
    expect(existsSync(join(fx.from, "registry.sqlite"))).toBe(false);
    const rows = readRegistryRows(join(fx.to, "registry.sqlite"));
    const byId = Object.fromEntries(rows.map((r) => [r.thread_id, r.file_path]));
    expect(byId[fx.liveThreadId]).toBe(join(fx.to, "threads", fx.liveThreadName));
    expect(byId.th_other_bbbbbbbb).toBe(join(fx.to, "threads", "bbbb.sqlite"));
    expect(byId[fx.deadThreadId]).toBe(fx.deadPath); // untouched

    // Threads moved with WAL/SHM sidecars.
    expect(existsSync(join(fx.to, "threads", fx.liveThreadName))).toBe(true);
    expect(existsSync(join(fx.to, "threads", `${fx.liveThreadName}-wal`))).toBe(true);
    expect(existsSync(join(fx.to, "threads", `${fx.liveThreadName}-shm`))).toBe(true);
    expect(existsSync(join(fx.to, "threads", "bbbb.sqlite"))).toBe(true);
    expect(existsSync(join(fx.from, "threads"))).toBe(false);

    // .env copied (not moved).
    expect(readFileSync(join(fx.to, ".env"), "utf8")).toContain("OPENROUTER_API_KEY=fixture-key");
    expect(existsSync(join(fx.from, ".env"))).toBe(true);

    // Agent dir seeded; exclusions absent.
    const agent = join(fx.to, "pi", "agent");
    expect(readFileSync(join(agent, "auth.json"), "utf8")).toContain('"auth":true');
    expect(existsSync(join(agent, "models.json"))).toBe(true);
    expect(existsSync(join(agent, "settings.json"))).toBe(true);
    expect(existsSync(join(agent, "trust.json"))).toBe(true);
    expect(existsSync(join(agent, "extensions", "demo.ts"))).toBe(true);
    expect(existsSync(join(agent, "skills", "skill.md"))).toBe(true);
    expect(existsSync(join(agent, "sessions"))).toBe(false);
    expect(existsSync(join(agent, "settings.json.bak"))).toBe(false);
    // *.bak* excluded inside seeded dirs too, not just at the agent root.
    expect(existsSync(join(agent, "extensions", "demo.ts.bak"))).toBe(false);
    expect(existsSync(join(agent, "extensions", "nested", "secret.bak.2025"))).toBe(false);
    expect(existsSync(join(agent, "npm"))).toBe(false);
    expect(existsSync(join(agent, "bin"))).toBe(false);

    // Snapshot rail moved; git log still has the fixture commit.
    expect(existsSync(join(fx.to, ".git"))).toBe(true);
    expect(existsSync(join(fx.from, ".git"))).toBe(false);
    expect(readFileSync(join(fx.to, ".gitignore"), "utf8")).toContain(".env");
    const log = execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: fx.to,
      encoding: "utf8",
    });
    expect(log).toContain(fx.commitMessage);

    // backup.sh is the repo file, not the old one.
    const installed = readFileSync(join(fx.to, "backup.sh"), "utf8");
    const repoBackup = readFileSync(backupScript, "utf8");
    expect(installed).toBe(repoBackup);
    expect(installed).toContain("pi-lhc-backup:");
    expect(installed).not.toContain("old-backup");

    // Source leftovers remain for rollback.
    expect(existsSync(join(fx.from, "backup.sh"))).toBe(true);
    expect(readFileSync(join(fx.from, "backup.sh"), "utf8")).toContain("old-backup");
    expect(existsSync(join(fx.from, "cc-sessions.json"))).toBe(true);
  });

  it("--dry-run changes nothing and prints the plan including skip lines", () => {
    const fx = buildFixture();
    const beforeFrom = readdirSync(fx.from).sort();
    const result = runMigrate(["--from", fx.from, "--to", fx.to, "--pi-agent", fx.piAgent, "--dry-run"]);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("migrate-to-pi-lhc: plan");
    expect(result.stdout).toContain(`skip ${fx.deadThreadId} ${fx.deadPath}`);
    expect(result.stdout).toContain("rewrite");
    expect(result.stdout).toContain("dry-run complete");

    expect(readdirSync(fx.from).sort()).toEqual(beforeFrom);
    expect(existsSync(join(fx.from, "registry.sqlite"))).toBe(true);
    expect(existsSync(join(fx.to, "registry.sqlite"))).toBe(false);
    expect(existsSync(join(fx.to, "threads"))).toBe(false);
    expect(existsSync(join(fx.to, "backup.sh"))).toBe(false);
    expect(existsSync(join(fx.from, ".git"))).toBe(true);
  });

  it("missing --yes changes nothing and exits nonzero with notice", () => {
    const fx = buildFixture();
    const result = runMigrate(["--from", fx.from, "--to", fx.to, "--pi-agent", fx.piAgent]);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/pass --yes to run/);
    expect(existsSync(join(fx.from, "registry.sqlite"))).toBe(true);
    expect(existsSync(join(fx.to, "registry.sqlite"))).toBe(false);
  });

  it("refuses when destination already looks migrated", () => {
    const fx = buildFixture();
    // Pre-seed a registry at destination (already-migrated signal).
    writeFileSync(join(fx.to, "registry.sqlite"), "already-here");

    const result = runMigrate(["--from", fx.from, "--to", fx.to, "--pi-agent", fx.piAgent, "--yes"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/already migrated|already has registry/i);
    expect(existsSync(join(fx.from, "registry.sqlite"))).toBe(true);
  });

  it("keeps an agent file already present at the destination", () => {
    const fx = buildFixture({
      seedDestAgent: { "auth.json": '{"auth":"destination-kept"}\n' },
    });
    const result = runMigrate(["--from", fx.from, "--to", fx.to, "--pi-agent", fx.piAgent, "--yes"]);

    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toMatch(/keep agent file auth\.json/);
    expect(readFileSync(join(fx.to, "pi", "agent", "auth.json"), "utf8")).toBe('{"auth":"destination-kept"}\n');
    // Other agent files still seed.
    expect(existsSync(join(fx.to, "pi", "agent", "models.json"))).toBe(true);
  });

  it("refuses when a pi-lhc/dist/bin.js process is alive (even with --dry-run)", () => {
    // Hermetic: stub ps reports a node process whose argv token ends with
    // pi-lhc/dist/bin.js (the same shape as a real live session).
    const fx = buildFixture();
    const result = runMigrate(
      ["--from", fx.from, "--to", fx.to, "--pi-agent", fx.piAgent, "--dry-run"],
      envWithFakePs(ALIVE_PS),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refusing to run while pi-lhc is alive/i);
    expect(existsSync(join(fx.from, "registry.sqlite"))).toBe(true);
  });
});
