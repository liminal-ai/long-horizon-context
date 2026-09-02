/**
 * LIM-133: bounded archive projections.
 *
 * listEvents stays the explicit full-archive read. threadFrontier,
 * eventKeyPrefixCounts and listEventKeysByPrefix are the bounded surfaces:
 * constant or O(caller input) rows, indexed non-payload columns only, and
 * closed contracts for duplicate/overlapping prefixes, invalid caps/cursors
 * and cap exhaustion.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDeterministicInferenceCallbacks,
  initLhc,
  intakeStream,
  type Lhc,
  type MessageEventInput,
} from "../src/index.js";
import {
  FRONTIER_LAST_EVENT_SQL,
  FRONTIER_METADATA_SQL,
  FRONTIER_VIEW_BOUNDARY_SQL,
  KEY_CURSOR_WITNESS_LIMIT,
  KEY_CURSOR_WITNESS_SQL,
  KEY_WALK_FRONTIER_SQL,
  PAGE_SQL_SHAPES,
  prefixUpperBound,
} from "../src/intake-stream/internal/pipeline.js";
import { type TempStore, tempStore, validEvent } from "./fixtures/index.js";

const { LEGACY_KEY_PAGE_LIMIT, LEGACY_KEY_TOTAL_LOOKUP_CAP } = intakeStream;

function keyedNote(key: string): MessageEventInput {
  return validEvent("runtime_note", { idempotencyKey: key, payload: { text: key } });
}

// exactOptionalPropertyTypes: an absent cursor must be omitted, not undefined.
function pageQuery(prefix: string, limit: number, cursor?: string): intakeStream.EventKeyPageQuery {
  return cursor === undefined ? { prefix, limit } : { prefix, limit, cursor };
}

// "v1:<frontier>:<traversed>:<lastKey>" — split so a test can tamper with one
// field of an otherwise authentic, server-issued cursor.
function cursorParts(cursor: string): { frontier: string; traversed: string; lastKey: string } {
  const [version, frontier, traversed, ...rest] = cursor.split(":");
  expect(version).toBe("v1");
  return { frontier: frontier as string, traversed: traversed as string, lastKey: rest.join(":") };
}

function retamper(
  cursor: string,
  overrides: Partial<{ frontier: string; traversed: string; lastKey: string }>,
): string {
  const parts = { ...cursorParts(cursor), ...overrides };
  return `v1:${parts.frontier}:${parts.traversed}:${parts.lastKey}`;
}

describe("bounded archive projections", () => {
  let store: TempStore;
  let sdk: Lhc;
  let filePath: string;

  beforeEach(async () => {
    store = tempStore();
    sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
    filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
  });

  afterEach(() => {
    store.cleanup();
  });

  describe("thread frontier", () => {
    it("is constant-row on an empty archive and after appends", async () => {
      const empty = await sdk.intakeStream.threadFrontier({ filePath });
      expect(empty.ok).toBe(true);
      if (!empty.ok) return;
      expect(empty.value.lastEventOrder).toBe(0);
      expect(empty.value.lastRecordedAt).toBeNull();
      expect(empty.value.viewBoundaryPosition).toBe(0);
      expect(empty.value.threadId).toMatch(/^th_[0-9a-f]{16}$/);
      expect(empty.value.createdAt).not.toBe("");

      const recorded = await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("user_prompt", { payload: { text: "q" } }),
        validEvent("assistant_text", { payload: { text: "a" } }),
        validEvent("turn_end"),
      ]);
      expect(recorded.ok).toBe(true);

      const after = await sdk.intakeStream.threadFrontier({ filePath });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.lastEventOrder).toBe(3);
      expect(after.value.lastRecordedAt).not.toBeNull();
      expect(after.value.threadId).toBe(empty.value.threadId);
      expect(after.value.createdAt).toBe(empty.value.createdAt);
      // Same field set regardless of archive size: nothing here is a list.
      expect(Object.keys(after.value).sort()).toEqual([
        "createdAt",
        "lastEventOrder",
        "lastRecordedAt",
        "threadId",
        "viewBoundaryPosition",
      ]);
    });

    it("tracks the recorded event counter that messageEvents reports", async () => {
      const batch = await sdk.intakeStream.messageEvents({ filePath }, [
        validEvent("runtime_note"),
        validEvent("runtime_note"),
      ]);
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;
      const frontier = await sdk.intakeStream.threadFrontier({ filePath });
      expect(frontier.ok).toBe(true);
      if (!frontier.ok) return;
      expect(frontier.value.lastEventOrder).toBe(batch.value.threadPosition.lastEventOrder);
    });

    it("rejects an unusable thread reference without opening storage", async () => {
      const result = await sdk.intakeStream.threadFrontier({ filePath: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.errorClass).toBe("caller_error");
    });

    it("reads no payload column in any frontier statement", () => {
      for (const sql of [FRONTIER_METADATA_SQL, FRONTIER_LAST_EVENT_SQL, FRONTIER_VIEW_BOUNDARY_SQL]) {
        expect(sql).not.toMatch(/payload/);
        expect(sql).not.toMatch(/COUNT\(/i);
      }
      // The only event statement is a single newest row.
      expect(FRONTIER_LAST_EVENT_SQL).toMatch(/ORDER BY event_order DESC LIMIT 1$/);
    });
  });

  describe("key prefix existence and count", () => {
    beforeEach(async () => {
      const recorded = await sdk.intakeStream.messageEvents({ filePath }, [
        keyedNote("codex:s1:a"),
        keyedNote("codex:s1:b"),
        keyedNote("codex:s2:a"),
        keyedNote("other:x"),
      ]);
      expect(recorded.ok).toBe(true);
    });

    it("returns one row per distinct prefix in first-occurrence order", async () => {
      const result = await sdk.intakeStream.eventKeyPrefixCounts({ filePath }, [
        "codex:s1:",
        "missing:",
        "codex:s1:",
        "codex:",
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([
        { prefix: "codex:s1:", exists: true, count: 2 },
        { prefix: "missing:", exists: false, count: 0 },
        // Overlap is independent: keys under codex:s1: are counted again here.
        { prefix: "codex:", exists: true, count: 3 },
      ]);
      expect(result.value.length).toBeLessThanOrEqual(4);
    });

    it("returns an empty result for an empty prefix list", async () => {
      const result = await sdk.intakeStream.eventKeyPrefixCounts({ filePath }, []);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it("refuses an empty prefix as invalid bounds", async () => {
      const result = await sdk.intakeStream.eventKeyPrefixCounts({ filePath }, ["codex:", ""]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("invalid_bounds");
      expect(result.error.errorClass).toBe("caller_error");
    });

    it("matches the exact prefix boundary, not a looser range", async () => {
      const recorded = await sdk.intakeStream.messageEvents({ filePath }, [keyedNote("codex;z")]);
      expect(recorded.ok).toBe(true);
      // ';' is the byte immediately after ':' — the upper bound must exclude it.
      const result = await sdk.intakeStream.eventKeyPrefixCounts({ filePath }, ["codex:"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.count).toBe(3);
    });

    it("handles non-ascii prefixes at the code-point boundary", async () => {
      const recorded = await sdk.intakeStream.messageEvents({ filePath }, [
        keyedNote("ключ-é:1"),
        keyedNote("ключ-é:2"),
        keyedNote("ключ-ê:1"),
      ]);
      expect(recorded.ok).toBe(true);
      const result = await sdk.intakeStream.eventKeyPrefixCounts({ filePath }, ["ключ-é"]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([{ prefix: "ключ-é", exists: true, count: 2 }]);
    });
  });

  describe("prefix upper bound", () => {
    it("increments the final code point", () => {
      expect(prefixUpperBound("codex:")).toBe("codex;");
      expect(prefixUpperBound("a")).toBe("b");
    });

    it("skips the surrogate gap", () => {
      expect(prefixUpperBound("\ud7ff")).toBe("\ue000");
    });

    it("carries past U+10FFFF and reports no bound when it runs out", () => {
      expect(prefixUpperBound("a\u{10ffff}")).toBe("b");
      expect(prefixUpperBound("\u{10ffff}")).toBeUndefined();
      expect(prefixUpperBound("\u{10ffff}\u{10ffff}")).toBeUndefined();
    });
  });

  describe("legacy prefix listing", () => {
    const total = 25;

    beforeEach(async () => {
      const events = Array.from({ length: total }, (_, i) => keyedNote(`legacy:${String(i).padStart(3, "0")}`));
      const recorded = await sdk.intakeStream.messageEvents({ filePath }, events);
      expect(recorded.ok).toBe(true);
    });

    it("walks every key exactly once in stable key order across pages", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, pageQuery("legacy:", 7, cursor));
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        pages += 1;
        expect(page.value.keys.length).toBeLessThanOrEqual(7);
        expect(page.value.capExhausted).toBe(false);
        seen.push(...page.value.keys.map((entry) => entry.idempotencyKey));
        if (page.value.cursor === null) {
          expect(page.value.complete).toBe(true);
          break;
        }
        expect(page.value.complete).toBe(false);
        cursor = page.value.cursor;
      }
      expect(pages).toBe(4);
      expect(seen.length).toBe(total);
      expect(new Set(seen).size).toBe(total);
      expect([...seen]).toEqual([...seen].sort());
      expect(seen[0]).toBe("legacy:000");
      expect(seen[total - 1]).toBe("legacy:024");
    });

    it("refuses a stale cursor once anything is appended, and the next walk sees the appends", async () => {
      const first = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", limit: 10 });
      expect(first.ok).toBe(true);
      if (!first.ok || first.value.cursor === null) throw new Error("expected a continuation");
      const issued = first.value.cursor;
      expect(first.value.keys[9]?.idempotencyKey).toBe("legacy:009");

      // A key sorting after everything this walk could still return. The
      // cursor's own rank arithmetic is untouched by it, so nothing but exact
      // frontier equality can catch it: a check that only refused a cursor
      // *ahead* of the frontier would continue the walk here and quietly
      // absorb a row that was not in it.
      const later = await sdk.intakeStream.messageEvents({ filePath }, [keyedNote("legacy:900")]);
      expect(later.ok).toBe(true);

      const afterLater = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", cursor: issued },
      );
      expect(afterLater.ok).toBe(false);
      if (afterLater.ok) return;
      expect(afterLater.error.errorClass).toBe("caller_error");
      expect(afterLater.error.code).toBe("invalid_bounds");
      expect(afterLater.error.reason).toContain("does not match the thread frontier");

      // A key sorting before the cursor's last returned key: equally stale,
      // and refused rather than silently skipped over.
      const earlier = await sdk.intakeStream.messageEvents({ filePath }, [keyedNote("legacy:0055")]);
      expect(earlier.ok).toBe(true);

      const afterEarlier = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", cursor: issued },
      );
      expect(afterEarlier.ok).toBe(false);
      if (afterEarlier.ok) return;
      expect(afterEarlier.error.code).toBe("invalid_bounds");
      expect(afterEarlier.error.reason).toContain("does not match the thread frontier");

      // Visible degradation, not lost rows: a fresh walk — itself paged over
      // none but server-issued cursors — returns the original keys plus both
      // appends in exact key order.
      const seen: string[] = [];
      let cursor: string | undefined;
      let complete = false;
      for (;;) {
        const page = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, pageQuery("legacy:", 10, cursor));
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        seen.push(...page.value.keys.map((entry) => entry.idempotencyKey));
        complete = page.value.complete;
        if (page.value.cursor === null) break;
        cursor = page.value.cursor;
      }
      expect(complete).toBe(true);
      expect(seen).toEqual(
        [
          ...Array.from({ length: total }, (_, i) => `legacy:${String(i).padStart(3, "0")}`),
          "legacy:0055",
          "legacy:900",
        ].sort(),
      );
      // Byte order, not arrival order: the earlier append lands between
      // legacy:005 and legacy:006, the later one at the very end.
      expect(seen[6]).toBe("legacy:0055");
      expect(seen[seen.length - 1]).toBe("legacy:900");
    });

    it("returns the archive position with each key and never a payload", async () => {
      const page = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:00", limit: 3 });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const entry of page.value.keys) {
        expect(Object.keys(entry).sort()).toEqual(["eventOrder", "idempotencyKey"]);
        expect(entry.eventOrder).toBeGreaterThan(0);
      }
      for (const sql of PAGE_SQL_SHAPES) {
        expect(sql).not.toMatch(/payload/);
        expect(sql).toMatch(/LIMIT \?/);
        // No order filter: it would let post-cursor appends interleave into
        // the key range and be examined past the row LIMIT.
        expect(sql).not.toMatch(/event_order <= \?/);
      }
      // The cursor witness is indexed, non-payload, order-filter-free and
      // hard-limited to the total lookup cap: it never counts the whole
      // history and never examines more entries than the cap.
      expect(KEY_CURSOR_WITNESS_SQL).not.toMatch(/payload/);
      expect(KEY_CURSOR_WITNESS_SQL).not.toMatch(/event_order/);
      expect(KEY_CURSOR_WITNESS_SQL.match(/LIMIT \?/g)).toHaveLength(1);
      expect(KEY_CURSOR_WITNESS_LIMIT).toBe(LEGACY_KEY_TOTAL_LOOKUP_CAP);
      // The frontier probe is one index-endpoint row, not a count.
      expect(KEY_WALK_FRONTIER_SQL).not.toMatch(/payload/);
      expect(KEY_WALK_FRONTIER_SQL).not.toMatch(/COUNT\(/i);
      expect(KEY_WALK_FRONTIER_SQL).toMatch(/ORDER BY event_order DESC LIMIT 1$/);
    });

    it("refuses a limit above the hard page cap instead of clamping", async () => {
      const result = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", limit: LEGACY_KEY_PAGE_LIMIT + 1 },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("invalid_bounds");
      expect(result.error.reason).toContain("LEGACY_KEY_PAGE_LIMIT");
    });

    it("refuses non-integer and non-positive limits", async () => {
      for (const limit of [0, -1, 1.5]) {
        const result = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", limit });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("invalid_bounds");
      }
    });

    it("refuses an empty prefix and every malformed, foreign or out-of-range cursor", async () => {
      const empty = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "" });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.error.code).toBe("invalid_bounds");

      for (const cursor of [
        "",
        "abc",
        // Pre-version grammar and wrong versions.
        "3:legacy:001",
        "1:5:legacy:001",
        "v0:5:1:legacy:001",
        "v2:5:1:legacy:001",
        // Missing fields.
        "v1:legacy:001",
        "v1:5:legacy:001",
        // Non-decimal, signed and exponent forms in either integer field.
        "v1:x:1:legacy:001",
        "v1:5:x:legacy:001",
        "v1:-1:1:legacy:001",
        "v1:5:-1:legacy:001",
        "v1:1e3:1:legacy:001",
        "v1:5:1e3:legacy:001",
        // Traversed outside 1..cap.
        "v1:5:0:legacy:001",
        `v1:5:${LEGACY_KEY_TOTAL_LOOKUP_CAP + 1}:legacy:001`,
        // First unsafe integer, and an overflowing one, in either field.
        "v1:9007199254740992:1:legacy:001",
        "v1:5:9007199254740992:legacy:001",
        "v1:99999999999999999999:1:legacy:001",
        "v1:5:99999999999999999999:legacy:001",
      ]) {
        const bad = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", cursor });
        expect(bad.ok, `cursor ${JSON.stringify(cursor)} must be refused`).toBe(false);
        if (!bad.ok) expect(bad.error.code).toBe("invalid_bounds");
      }

      const foreign = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", cursor: "v1:25:3:other:001" },
      );
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.error.reason).toContain("different prefix");
    });

    it("refuses a cursor whose last key is absent under the prefix", async () => {
      const first = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", limit: 10 });
      expect(first.ok).toBe(true);
      if (!first.ok || first.value.cursor === null) throw new Error("expected a continuation");

      // Same authentic frontier and count, a key that was never recorded: the
      // continuation must refuse rather than resume past the missing key.
      const forged = retamper(first.value.cursor, { lastKey: "legacy:250" });
      const result = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", cursor: forged });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("invalid_bounds");
      expect(result.error.reason).toContain("not present under this prefix");
    });

    it("refuses a reset or mismatched traversed count", async () => {
      const first = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", limit: 10 });
      expect(first.ok).toBe(true);
      if (!first.ok || first.value.cursor === null) throw new Error("expected a continuation");
      const authentic = first.value.cursor;
      expect(cursorParts(authentic).traversed).toBe("10");

      for (const traversed of ["0", "1", "9", "11", String(LEGACY_KEY_TOTAL_LOOKUP_CAP)]) {
        const result = await sdk.intakeStream.listEventKeysByPrefix(
          { filePath },
          { prefix: "legacy:", cursor: retamper(authentic, { traversed }) },
        );
        expect(result.ok, `traversed ${traversed} must be refused`).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("invalid_bounds");
      }

      // The untouched cursor still works, so the refusals are about the count.
      const honest = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", cursor: authentic },
      );
      expect(honest.ok).toBe(true);
    });

    it("refuses a cursor whose frontier is not the current thread frontier", async () => {
      const first = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", limit: 10 });
      expect(first.ok).toBe(true);
      if (!first.ok || first.value.cursor === null) throw new Error("expected a continuation");
      expect(cursorParts(first.value.cursor).frontier).toBe(String(total));

      // Ahead of the archive and behind it are the same refusal: only exact
      // equality continues a walk.
      for (const frontier of ["999999", "1"]) {
        const result = await sdk.intakeStream.listEventKeysByPrefix(
          { filePath },
          { prefix: "legacy:", cursor: retamper(first.value.cursor, { frontier }) },
        );
        expect(result.ok, `frontier ${frontier} must be refused`).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("invalid_bounds");
        expect(result.error.reason).toContain("does not match the thread frontier");
      }
    });

    it("completes rather than exhausting when the prefix ends inside the cap", async () => {
      const page = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", limit: LEGACY_KEY_PAGE_LIMIT },
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.keys.length).toBe(total);
      expect(page.value.complete).toBe(true);
      expect(page.value.capExhausted).toBe(false);
      expect(page.value.cursor).toBeNull();
    });

    it("returns an empty complete page for a prefix with no keys", async () => {
      const page = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "absent:" });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value).toEqual({ keys: [], cursor: null, complete: true, capExhausted: false });
    });
  });

  describe("total lookup cap at its exact boundary", () => {
    // Seeded through the public intake API and walked with none but
    // server-issued cursors: the cap is proven by real rows, not by a
    // hand-written count no walk could ever have emitted.
    async function seedKeys(from: number, toExclusive: number): Promise<void> {
      for (let base = from; base < toExclusive; base += 250) {
        const events = Array.from({ length: Math.min(250, toExclusive - base) }, (_, i) =>
          keyedNote(`cap:${String(base + i).padStart(4, "0")}`),
        );
        const recorded = await sdk.intakeStream.messageEvents({ filePath }, events);
        expect(recorded.ok).toBe(true);
      }
    }

    async function walk(): Promise<intakeStream.EventKeyPage & { seen: string[] }> {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await sdk.intakeStream.listEventKeysByPrefix(
          { filePath },
          pageQuery("cap:", LEGACY_KEY_PAGE_LIMIT, cursor),
        );
        if (!page.ok) throw new Error(page.error.reason);
        seen.push(...page.value.keys.map((entry) => entry.idempotencyKey));
        if (page.value.cursor === null) return { ...page.value, seen };
        cursor = page.value.cursor;
      }
    }

    it("completes exactly at the cap and degrades one row past it", async () => {
      await seedKeys(0, LEGACY_KEY_TOTAL_LOOKUP_CAP);
      const exact = await walk();
      expect(exact.seen.length).toBe(LEGACY_KEY_TOTAL_LOOKUP_CAP);
      expect(new Set(exact.seen).size).toBe(LEGACY_KEY_TOTAL_LOOKUP_CAP);
      expect(exact.complete).toBe(true);
      expect(exact.capExhausted).toBe(false);
      expect(exact.cursor).toBeNull();

      // One more matching row: the walk must stop after the cap and say so.
      await seedKeys(LEGACY_KEY_TOTAL_LOOKUP_CAP, LEGACY_KEY_TOTAL_LOOKUP_CAP + 1);
      const over = await walk();
      expect(over.seen.length).toBe(LEGACY_KEY_TOTAL_LOOKUP_CAP);
      expect(over.complete).toBe(false);
      expect(over.capExhausted).toBe(true);
      expect(over.cursor).toBeNull();
      expect(over.seen).not.toContain(`cap:${String(LEGACY_KEY_TOTAL_LOOKUP_CAP).padStart(4, "0")}`);

      // A cursor pointing past the cap — authentic frontier, real key, rank
      // 2001 — is refused rather than resumed: no walk may reach that row.
      const firstPage = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "cap:", limit: LEGACY_KEY_PAGE_LIMIT },
      );
      expect(firstPage.ok).toBe(true);
      if (!firstPage.ok || firstPage.value.cursor === null) throw new Error("expected a continuation");
      const beyondCap = retamper(firstPage.value.cursor, {
        lastKey: `cap:${String(LEGACY_KEY_TOTAL_LOOKUP_CAP).padStart(4, "0")}`,
      });
      const refused = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "cap:", cursor: beyondCap });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe("invalid_bounds");
      expect(refused.error.reason).toContain("rank exceeds LEGACY_KEY_TOTAL_LOOKUP_CAP");
    });
  });

  describe("full archive API is unchanged", () => {
    it("listEvents still returns every event with its payload", async () => {
      const recorded = await sdk.intakeStream.messageEvents(
        { filePath },
        Array.from({ length: 12 }, (_, i) => keyedNote(`bulk:${i}`)),
      );
      expect(recorded.ok).toBe(true);
      const listed = await sdk.intakeStream.listEvents({ filePath });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.length).toBe(12);
      expect(listed.value[0]?.payload).toEqual({ text: "bulk:0" });
    });
  });
});
