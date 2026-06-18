// Epic 07 Story 0 — Flow 0 foundation: the restructure is in place and the
// import-boundary rules are enforced (AC-0.1, AC-0.2, AC-0.4, AC-0.6) plus the
// rename's persisted-state risk (AC-0.4 §Rename Migration): a thread file
// carrying a stale lower_band_projection work item must not crash a worker on
// first open — the v9 migration deletes the row and records a warning.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkSource } from "../scripts/check-boundaries.mjs";
import { createDeterministicInferenceCallbacks, initLhc } from "../src/index.js";
import { openDatabase } from "../src/shared-tech/storage.js";
import { openThreadDatabase } from "../src/threads/index.js";
import { tempStore, type TempStore } from "./fixtures/index.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(pkgRoot, "src");
const SIX_DOMAINS = ["intake-stream", "messages", "turns", "threads", "thread-view", "inspect"];
const OLD_TOP_LEVEL = ["inference", "providers", "shared", "tech-utils"];

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const stores: TempStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.cleanup();
});

describe("TC-0.1a: domain surfaces are top-level folders (AC-0.1)", () => {
  it("the six domains are direct children of src/ and no domains/ wrapper exists", () => {
    for (const domain of SIX_DOMAINS) {
      expect(existsSync(path.join(srcRoot, domain)), `${domain} should exist`).toBe(true);
    }
    expect(existsSync(path.join(srcRoot, "domains"))).toBe(false);
  });
});

describe("TC-0.2a: one shared-tech area, no old top-level tech folders (AC-0.2)", () => {
  it("src/shared-tech/ exists with the consolidated infrastructure", () => {
    expect(existsSync(path.join(srcRoot, "shared-tech"))).toBe(true);
    expect(existsSync(path.join(srcRoot, "shared-tech", "derivation.ts"))).toBe(true);
    expect(existsSync(path.join(srcRoot, "shared-tech", "inference-adapter.ts"))).toBe(true);
    expect(existsSync(path.join(srcRoot, "shared-tech", "prompts"))).toBe(true);
    expect(existsSync(path.join(srcRoot, "shared-tech", "work-queue"))).toBe(true);
  });

  it("the old top-level technical folders are gone", () => {
    for (const old of OLD_TOP_LEVEL) {
      expect(existsSync(path.join(srcRoot, old)), `${old}/ should not exist`).toBe(false);
    }
  });
});

describe("TC-0.4a: rename is complete in source (AC-0.4)", () => {
  it("the schema backfill and prompt registry use smooth_turn_compression", () => {
    const storage = readFileSync(path.join(srcRoot, "shared-tech", "storage.ts"), "utf8");
    expect(storage).toContain("smooth_turn_compression");
    const prompts = readFileSync(path.join(srcRoot, "shared-tech", "prompts", "index.ts"), "utf8");
    expect(prompts).toContain("smooth_turn_compression");
  });

  it("no source file references lower_band_projection except the v9 migration cleanup", () => {
    const offenders = collectTsFiles(srcRoot)
      .filter((file) => readFileSync(file, "utf8").includes("lower_band_projection"))
      .map((file) => path.relative(srcRoot, file));
    // The only sanctioned reference is shared-tech/storage.ts's MIGRATION_V9,
    // which deletes stale queued work that still names the pre-rename type.
    expect(offenders).toEqual(["shared-tech" + path.sep + "storage.ts"]);
  });
});

describe("TC-0.6a / TC-0.6b: import-boundary rules enforced (AC-0.6)", () => {
  it("shared-tech importing a domain is a violation (TC-0.6a)", () => {
    const violations = checkSource(
      path.join(srcRoot, "shared-tech", "x.ts"),
      `import { a } from "../messages/index.js";`,
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toMatch(/shared-tech may not import domain/);
  });

  it("a domain importing another domain's internal/ is a violation (TC-0.6b)", () => {
    const violations = checkSource(
      path.join(srcRoot, "turns", "internal", "x.ts"),
      `import { b } from "../../messages/internal/secret.js";`,
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toMatch(/reaches into domain "messages" internal/);
  });

  it("a domain importing shared-tech through the public index is allowed", () => {
    const violations = checkSource(
      path.join(srcRoot, "turns", "x.ts"),
      `import { c } from "../shared-tech/index.js";`,
    );
    expect(violations).toEqual([]);
  });

  it("a domain importing arbitrary shared-tech files is a violation", () => {
    const violations = checkSource(
      path.join(srcRoot, "turns", "x.ts"),
      `import { c } from "../shared-tech/derivation.js";`,
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toMatch(/shared-tech public entrypoint/);
  });

  it("a domain importing another domain's pinned surface is allowed", () => {
    // turns → messages is a pinned surface edge.
    const violations = checkSource(
      path.join(srcRoot, "turns", "internal", "x.ts"),
      `import { d } from "../../messages/recovery.js";`,
    );
    expect(violations).toEqual([]);
  });

  it("the real boundary checker passes on the current tree (enforced every CI run)", () => {
    const result = spawnSync(process.execPath, [path.join(pkgRoot, "scripts", "check-boundaries.mjs")], {
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe("AC-0.4 architecture-risk: stale lower_band_projection work items are deleted on first open", () => {
  it("a queued item referencing the old name is removed by the v9 migration and a warning is logged", async () => {
    const store = tempStore();
    stores.push(store);
    const filePath = store.threadPath();
    const sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);

    // Seed a stale queued work item exactly as it would have existed before
    // the rename, then roll the schema back to v8 so the v9 migration re-runs
    // on the next production open.
    const seed = openDatabase(filePath);
    seed.exec("PRAGMA user_version = 8;");
    const stalePayload = JSON.stringify({
      sourceVersion: 1,
      derivations: [
        { subjectKind: "turn", subjectId: "t1", derivationType: "lower_band_projection" },
      ],
    });
    seed
      .prepare(
        `INSERT INTO work_item (work_item_id, owner, kind, source_ref, status, queued_at, payload)
         VALUES (?, 'turns', 'turn_derivation', ?, 'queued', ?, ?)`,
      )
      .run("w-stale-1", JSON.stringify({ turnId: "t1" }), "2026-01-01T00:00:00.000Z", stalePayload);
    seed.close();

    const opened = openThreadDatabase(filePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      const remaining = db
        .prepare(`SELECT COUNT(*) AS n FROM work_item WHERE payload LIKE '%lower_band_projection%'`)
        .get() as { n: number | bigint };
      expect(Number(remaining.n)).toBe(0);

      const warning = db
        .prepare(`SELECT level, reason, derivation_type FROM log WHERE reason = 'rename_migration'`)
        .get() as { level: string; reason: string; derivation_type: string } | undefined;
      expect(warning).toBeDefined();
      expect(warning?.level).toBe("warning");
      expect(warning?.derivation_type).toBe("smooth_turn_compression");

      const version = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint };
      expect(Number(version.user_version)).toBe(9);
    } finally {
      db.close();
    }
  });
});
