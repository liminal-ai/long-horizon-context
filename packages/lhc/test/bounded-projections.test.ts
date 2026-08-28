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

    it("keeps already-returned rows stable when new keys are appended mid-walk", async () => {
      const first = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", limit: 10 });
      expect(first.ok).toBe(true);
      if (!first.ok || first.value.cursor === null) throw new Error("expected a continuation");

      const appended = await sdk.intakeStream.messageEvents({ filePath }, [
        keyedNote("legacy:900"),
        keyedNote("legacy:901"),
      ]);
      expect(appended.ok).toBe(true);

      const rest: string[] = [];
      let cursor: string | undefined = first.value.cursor;
      while (cursor !== undefined) {
        const page = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, pageQuery("legacy:", 10, cursor));
        expect(page.ok).toBe(true);
        if (!page.ok) return;
        rest.push(...page.value.keys.map((entry) => entry.idempotencyKey));
        cursor = page.value.cursor ?? undefined;
      }
      const firstKeys = first.value.keys.map((entry) => entry.idempotencyKey);
      // No page repeats an earlier row, and the appended keys land after them.
      expect(firstKeys.some((key) => rest.includes(key))).toBe(false);
      expect(rest).toContain("legacy:900");
      expect(rest).toContain("legacy:901");
      expect([...firstKeys, ...rest]).toEqual([...firstKeys, ...rest].sort());
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
      }
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

    it("refuses an empty prefix and a malformed or foreign cursor", async () => {
      const empty = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "" });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.error.code).toBe("invalid_bounds");

      for (const cursor of ["", "abc", ":legacy:001", "-1:legacy:001", "1e3:legacy:001"]) {
        const bad = await sdk.intakeStream.listEventKeysByPrefix({ filePath }, { prefix: "legacy:", cursor });
        expect(bad.ok, `cursor ${JSON.stringify(cursor)} must be refused`).toBe(false);
        if (!bad.ok) expect(bad.error.code).toBe("invalid_bounds");
      }

      const foreign = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", cursor: "3:other:001" },
      );
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.error.reason).toContain("different prefix");
    });

    it("reports cap exhaustion as a degraded result, never as complete", async () => {
      const nearCap = LEGACY_KEY_TOTAL_LOOKUP_CAP - 3;
      const page = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", limit: 10, cursor: `${nearCap}:legacy:000` },
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      expect(page.value.keys.length).toBe(3);
      expect(page.value.capExhausted).toBe(true);
      expect(page.value.complete).toBe(false);
      expect(page.value.cursor).toBeNull();

      const past = await sdk.intakeStream.listEventKeysByPrefix(
        { filePath },
        { prefix: "legacy:", cursor: `${LEGACY_KEY_TOTAL_LOOKUP_CAP}:legacy:000` },
      );
      expect(past.ok).toBe(true);
      if (!past.ok) return;
      expect(past.value).toEqual({ keys: [], cursor: null, complete: false, capExhausted: true });
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
