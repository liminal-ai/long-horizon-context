// Epic 03 Story 5: render targets (TC-5.1, TC-5.2, TC-5.3, TC-5.5). One
// view, two shapes: model-context messages and the materialized PI session
// file must carry the same content because they come from the same assembly.
// Every TC goes through the real SDK surface (initLhc().threadView.*)
// against real temp thread files; the inference callbacks double appears only in
// fixture setup. The format fixture is a structure-trimmed REAL PI session
// file (test/fixtures/pi-session-structure.jsonl, provenance note beside it)
// — conformance shapes derive from it at runtime, never from the design's
// description. The CLI legs (TC-5.4 + parity rows) live in
// cli-process-view.test.ts under the process suite.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initLhc, type Lhc, type LlmRequestContextMessage } from "../src/index.js";
import {
  assertPiSessionConformance,
  createInferenceCallbacksDouble,
  type DerivedThreadFixture,
  derivedThreadFixture,
  eventBatch,
  openRaw,
  type TempStore,
  tempStore,
} from "./fixtures/index.js";

let store: TempStore;
let fixture: DerivedThreadFixture;

beforeAll(async () => {
  store = tempStore();
  fixture = await derivedThreadFixture(store);
});
afterAll(() => {
  store.cleanup();
});

// All three bands non-empty (Story 2's reference config: smooth t7+t8,
// detailed c2, brief c1; compact point at t9's start).
const GRADIENT_PARAMS = {
  lowerBound: 400,
  percentages: { full: 25, smooth: 16, detailed: 10, brief: 49 },
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// Full thread-file state, view rows and boundary included — materialize must
// change NONE of it (AC-5.2: the write changes no thread state).
function fullStateHash(filePath: string): string {
  const db = openRaw(filePath);
  try {
    return sha256(
      JSON.stringify({
        events: db.prepare(`SELECT * FROM event ORDER BY event_order`).all(),
        messages: db.prepare(`SELECT * FROM message ORDER BY source_event_order`).all(),
        blocks: db.prepare(`SELECT * FROM message_block ORDER BY message_id, block_index`).all(),
        turns: db.prepare(`SELECT * FROM turns ORDER BY turn_order`).all(),
        chunks: db.prepare(`SELECT * FROM chunk ORDER BY chunk_order`).all(),
        members: db.prepare(`SELECT * FROM chunk_member ORDER BY chunk_id, member_idx`).all(),
        derivations: db.prepare(`SELECT * FROM derivation ORDER BY subject_kind, subject_id, derivation_type`).all(),
        views: db.prepare(`SELECT * FROM thread_view`).all(),
        bands: db.prepare(`SELECT * FROM thread_view_band ORDER BY band`).all(),
        boundary: db.prepare(`SELECT * FROM view_boundary`).all(),
        work: db.prepare(`SELECT * FROM work_item ORDER BY work_item_id`).all(),
      }),
    );
  } finally {
    db.close();
  }
}

interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message: { role: string; content: Array<{ type: string; text: string }> };
}

function readSessionFile(path: string): {
  text: string;
  header: Record<string, unknown>;
  entries: SessionEntry[];
} {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((line) => line !== "");
  const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  const entries = lines.slice(1).map((line) => JSON.parse(line) as SessionEntry);
  return { text, header, entries };
}

function messageText(message: LlmRequestContextMessage | undefined): string | undefined {
  return message?.content.map((part) => part.text).join("");
}

describe("TC-5.1 (AC-5.1): model context opens with band context messages in gradient order, tail in record order, deterministic", () => {
  it("bands brief → detailed → smooth with labels, then the tail; repeated contexts byte-identical", async () => {
    const ref = { filePath: fixture.filePath };
    const compacted = await fixture.sdk.threadView.compact(ref, { params: GRADIENT_PARAMS });
    expect(compacted.ok).toBe(true);

    const first = await fixture.sdk.threadView.getLlmRequestContext(ref);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const messages = first.value.messages;
    const texts = messages.map((message) => messageText(message));

    // Band messages open the array in gradient order, each a labeled `user`
    // context message carrying its band marker.
    const bandTexts = texts.filter((text) => text?.startsWith("[context ·"));
    expect(bandTexts.map((text) => text?.match(/^\[context · ([^\]]+)\]/)?.[1])).toEqual([
      "brief",
      "detailed",
      "smooth",
    ]);
    for (let i = 0; i < bandTexts.length; i += 1) {
      expect(messages[i]?.role).toBe("user");
    }
    expect(texts.slice(0, bandTexts.length)).toEqual(bandTexts);

    // Tail follows in record order: with this config the compact point sits
    // at t9's start, so the tail opens with turn 9's prompt and carries the
    // turn 9–12 prompts in conversation order.
    const tail = messages.slice(bandTexts.length);
    const tailTexts = tail.map((message) => messageText(message));
    expect(tail[0]).toEqual({ role: "user", content: [{ type: "text", text: "turn 9: please investigate area 9" }] });
    const prompts = tailTexts.filter((text) => text?.startsWith("turn ")).map((text) => text?.split(":")[0]);
    expect(prompts).toEqual(["turn 9", "turn 10", "turn 11", "turn 12"]);
    // Roles per the pinned mapping: prompts/tool-results user, the
    // assistant kinds assistant.
    for (const m of tail) {
      const text = messageText(m) ?? "";
      if (text.startsWith("[tool call") || text.startsWith("[thinking]")) {
        expect(m.role).toBe("assistant");
      }
      if (text.startsWith("[tool result")) expect(m.role).toBe("user");
    }

    // Deterministic across repeated model-context reads: byte-identical result.
    const second = await fixture.sdk.threadView.getLlmRequestContext(ref);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
  });
});

describe("TC-5.2 (AC-5.2, AC-5.3): materialize/model-context parity, byte-identical repeat, thread state untouched", () => {
  it("every model-context message appears in the file, same order, same text; repeat is byte-identical; state hash unchanged", async () => {
    const ref = { filePath: fixture.filePath };
    // The view from TC-5.1's compact (suite order) — recompact defensively so
    // this test stands alone too.
    const compacted = await fixture.sdk.threadView.compact(ref, { params: GRADIENT_PARAMS });
    expect(compacted.ok).toBe(true);
    const contextMessages = await fixture.sdk.threadView.getLlmRequestContext(ref);
    expect(contextMessages.ok).toBe(true);
    if (!contextMessages.ok) return;

    const before = fullStateHash(fixture.filePath);
    const outPath = join(store.dir, "render-parity.jsonl");
    const materialized = await fixture.sdk.threadView.materialize(ref, { path: outPath });
    expect(materialized.ok).toBe(true);
    if (!materialized.ok) return;
    expect(materialized.value.writtenPath).toBe(outPath);

    // Item-for-item parity: same count, same order, same role, same rendered
    // text in the target encoding (one text block per message).
    const file = readSessionFile(outPath);
    expect(file.entries).toHaveLength(contextMessages.value.messages.length);
    file.entries.forEach((entry, i) => {
      const source = contextMessages.value.messages[i];
      expect(source).toBeDefined();
      if (source === undefined) return;
      expect(entry.message.role).toBe(source.role);
      expect(entry.message.content).toEqual(source.content);
    });

    // Band entries' generated fields derive from view metadata: the view's
    // created-at and viewId, never a write-time clock.
    const described = await fixture.sdk.threadView.describe(ref);
    expect(described.ok).toBe(true);
    if (!described.ok || described.value === null) return;
    expect(file.entries[0]?.timestamp).toBe(described.value.createdAt);
    expect(file.entries[0]?.id).toBe(`${described.value.viewId}-brief`);
    expect(file.header["timestamp"]).toBe(described.value.createdAt);

    // Repeat with no thread changes → byte-identical file.
    const again = await fixture.sdk.threadView.materialize(ref, { path: outPath });
    expect(again.ok).toBe(true);
    expect(sha256(readFileSync(outPath))).toBe(sha256(Buffer.from(file.text)));

    // The write changed no thread state — full-file hash, view rows and
    // boundary included.
    expect(fullStateHash(fixture.filePath)).toBe(before);
  });

  it("rejects an unknown format naming the accepted values, writing nothing", async () => {
    const outPath = join(store.dir, "never-written.jsonl");
    const result = await fixture.sdk.threadView.materialize(
      { filePath: fixture.filePath },
      { path: outPath, format: "markdown" as "pi-session" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorClass).toBe("caller_error");
    expect(result.error.code).toBe("unknown_format");
    expect(result.error.reason).toContain("pi-session");
    expect(() => readFileSync(outPath)).toThrow();
  });
});

describe("TC-5.3 (AC-5.4): a never-compacted thread materializes its tail-only view", () => {
  it("valid file, tail-only content, loadable against the format fixture, header from the thread's created-at", async () => {
    const sdk: Lhc = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    const filePath = store.threadPath("never-compacted");
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    expect(created.ok).toBe(true);
    const seeded = await sdk.intakeStream.messageEvents({ filePath }, [
      ...eventBatch(["user_prompt", "assistant_text", "turn_end"]),
      ...eventBatch(["user_prompt", "assistant_text"]),
    ]);
    expect(seeded.ok).toBe(true);

    const outPath = join(store.dir, "tail-only.jsonl");
    const materialized = await sdk.threadView.materialize({ filePath }, { path: outPath });
    expect(materialized.ok).toBe(true);

    const file = readSessionFile(outPath);
    expect(() => assertPiSessionConformance(file.text)).not.toThrow();

    // Tail-only: every entry is a record message (no band context entries),
    // matching the model context of the same never-compacted thread.
    const contextMessages = await sdk.threadView.getLlmRequestContext({ filePath });
    expect(contextMessages.ok).toBe(true);
    if (!contextMessages.ok) return;
    const described = await sdk.threadView.describe({ filePath });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.value).toBeNull();
    // Four record messages (turn_end projects no message), zero band entries.
    expect(file.entries).toHaveLength(4);
    expect(file.entries.every((e) => !e.message.content[0]?.text.startsWith("[context ·"))).toBe(true);
    file.entries.forEach((entry, i) => {
      expect(entry.message.content).toEqual(contextMessages.value.messages[i]?.content);
    });

    // viewId null ⇒ the header derives from the thread's created-at.
    const db = openRaw(filePath);
    const meta = db.prepare(`SELECT thread_id, created_at FROM thread_metadata WHERE id = 1`).get() as {
      thread_id: string;
      created_at: string;
    };
    db.close();
    expect(file.header["timestamp"]).toBe(meta.created_at);
    expect(file.header["id"]).toBe(`${meta.thread_id}:${meta.created_at}`);
  });
});

describe("TC-5.5 (AC-5.3): materialized file conforms to the real-PI-session structure fixture", () => {
  it("header line, entry shape, parentId chain, message encoding all validate", async () => {
    const ref = { filePath: fixture.filePath };
    const compacted = await fixture.sdk.threadView.compact(ref, { params: GRADIENT_PARAMS });
    expect(compacted.ok).toBe(true);
    const outPath = join(store.dir, "conformance.jsonl");
    const materialized = await fixture.sdk.threadView.materialize(ref, { path: outPath });
    expect(materialized.ok).toBe(true);

    const file = readSessionFile(outPath);
    expect(() => assertPiSessionConformance(file.text)).not.toThrow();

    // The chain explicitly, beyond the helper: first entry parentId null,
    // every later entry chained to the previous id.
    expect(file.entries[0]?.parentId).toBeNull();
    for (let i = 1; i < file.entries.length; i += 1) {
      expect(file.entries[i]?.parentId).toBe(file.entries[i - 1]?.id);
    }
  });
});
