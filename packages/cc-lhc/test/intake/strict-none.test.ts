import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  lookupSessionLineage,
  openLineageDatabase,
  recordSessionThread,
} from "../../src/intake/lineage-db.js";
import { isCanonicalNoneRow } from "../../src/intake/prefix-boundary.js";

describe("strict known-none rows", () => {
  it("accepts canonical none encoding", () => {
    expect(
      isCanonicalNoneRow({
        prefix_provenance: "none",
        replayed_prefix_lines: 0,
        replayed_prefix_bytes: 0,
        replayed_prefix_sha256: null,
      }),
    ).toBe(true);
  });

  it("contradictory none rows become unknown on read", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-strict-none-"));
    mkdirSync(home, { recursive: true });
    const dbPath = join(home, "cc-lhc.sqlite");
    openLineageDatabase(dbPath); // init schema
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO cc_session_lineage
       (rollout_session_id, thread_id, updated_at, prefix_provenance,
        replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256)
       VALUES (?, ?, ?, 'none', 7, 0, NULL)`,
    ).run("bad-none", "th", new Date().toISOString());
    db.close();
    expect(lookupSessionLineage(dbPath, "bad-none")?.prefix.kind).toBe("unknown");
  });

  it("none with non-null digest becomes unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-strict-none2-"));
    const dbPath = join(home, "cc-lhc.sqlite");
    openLineageDatabase(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO cc_session_lineage
       (rollout_session_id, thread_id, updated_at, prefix_provenance,
        replayed_prefix_lines, replayed_prefix_bytes, replayed_prefix_sha256)
       VALUES (?, ?, ?, 'none', 0, 0, ?)`,
    ).run("bad-none2", "th", new Date().toISOString(), "ab".repeat(32));
    db.close();
    expect(lookupSessionLineage(dbPath, "bad-none2")?.prefix.kind).toBe("unknown");
  });

  it("ordinary rebind does not insert missing target as none", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-rebind-no-insert-"));
    const dbPath = join(home, "cc-lhc.sqlite");
    // No prior row
    recordSessionThread(dbPath, "missing-target", "th_x");
    expect(lookupSessionLineage(dbPath, "missing-target")).toBeUndefined();
  });

  it("explicit none insert still works", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-lhc-none-insert-"));
    const dbPath = join(home, "cc-lhc.sqlite");
    recordSessionThread(dbPath, "fresh", "th", {}, { prefix: { kind: "none" } });
    expect(lookupSessionLineage(dbPath, "fresh")?.prefix.kind).toBe("none");
  });
});
