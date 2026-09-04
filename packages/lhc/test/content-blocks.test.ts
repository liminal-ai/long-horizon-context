// Content blocks (images, documents, and every other non-text Messages API
// block) through intake and serving. The rule under test: LHC holds every
// block faithfully; binary/opaque payloads live in the blob table keyed by
// content hash; text never carries base64 anywhere in the record; the tail
// replays the real block; bands and every text reader see a short placeholder.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractBlobs, initLhc, inlineBlobs, type Lhc, type MessageEventInput, placeholderText } from "../src/index.js";
import { createInferenceCallbacksDouble, openRaw, type TempStore, tempStore, validEvent } from "./fixtures/index.js";

// A real 1x1 PNG and a stand-in PDF body; the bytes matter only as
// bytes — the hash and the length are what the record keeps.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_LEN = Buffer.from(PNG_B64, "base64").byteLength;
const IMAGE_PLACEHOLDER = `[image · image/png · ${PNG_LEN} B]`;
const PDF_BYTES = Buffer.from(`%PDF-1.4\n${"x".repeat(120_000)}\n%%EOF`);
const PDF_B64 = PDF_BYTES.toString("base64");
// biome-ignore lint/suspicious/noExplicitAny: raw sqlite rows and served entries are checked structurally below
type Loose = Record<string, any>;
const loose = (value: unknown): Loose => value as Loose;
const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } };
const pdf = {
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: PDF_B64 },
  title: "spec.pdf",
};

describe("content blocks: pure helpers", () => {
  it("extracts base64 payloads to hash-keyed blobs and inlines them back byte-identical", () => {
    const { blocks, blobs } = extractBlobs([{ type: "text", text: "look" }, image, pdf]);
    expect(blobs.map((b: { sha256: string }) => b.sha256)).toEqual([sha(PNG_B64), sha(PDF_B64)]);
    expect(blobs[0]?.mediaType).toBe("image/png");
    expect(JSON.stringify(blocks)).not.toContain(PNG_B64.slice(0, 24));
    expect(loose(blocks[1]).source.data).toEqual({ $blob: `sha256:${sha(PNG_B64)}`, bytes: PNG_LEN });
    const store = new Map(blobs.map((b: { sha256: string; data: Uint8Array }) => [b.sha256, b.data]));
    const back = inlineBlobs(blocks, (h: string) => store.get(h));
    expect(back).toEqual([{ type: "text", text: "look" }, image, pdf]);
  });
  it("placeholders name the block, media type, size, and title — never the content", () => {
    const { blocks } = extractBlobs([image, pdf, { type: "redacted_thinking", data: "opaque" }]);
    expect(placeholderText(blocks[0])).toBe(IMAGE_PLACEHOLDER);
    expect(placeholderText(blocks[1])).toBe("[document · application/pdf · 117 KB · spec.pdf]");
    expect(placeholderText(blocks[2])).toBe("[redacted thinking]");
    expect(
      placeholderText({ type: "document", source: { type: "text", media_type: "text/plain", data: "plain body" } }),
    ).toBe("plain body");
  });
  it("opaque strings (redacted thinking, encrypted search content) are blobs too", () => {
    const search = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        { type: "web_search_result", title: "T", url: "https://x", encrypted_content: "ENCRYPTED", page_age: null },
      ],
    };
    const { blocks, blobs } = extractBlobs([search, { type: "redacted_thinking", data: "opaque" }]);
    expect(blobs).toHaveLength(2);
    expect(JSON.stringify(blocks)).not.toContain("ENCRYPTED");
    const store = new Map(blobs.map((b: { sha256: string; data: Uint8Array }) => [b.sha256, b.data]));
    expect(inlineBlobs(blocks, (h: string) => store.get(h))).toEqual([
      search,
      { type: "redacted_thinking", data: "opaque" },
    ]);
  });
});

describe("content blocks: intake and serving", () => {
  let store: TempStore;
  let sdk: Lhc;
  let filePath: string;
  beforeEach(async () => {
    store = tempStore();
    sdk = initLhc({ inferenceCallbacks: createInferenceCallbacksDouble(), mode: "manual" });
    filePath = store.threadPath();
    const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
    if (!created.ok) throw new Error(created.error.reason);
  });
  afterEach(() => store.cleanup());

  const intake = async (events: MessageEventInput[]) => {
    const result = await sdk.intakeStream.messageEvents({ filePath }, events);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.reason}`);
    return result.value;
  };

  it("a prompt with an image and a Read of a PNG: blobs stored once, no base64 in any text, the tail replays the real blocks", async () => {
    await intake([
      validEvent("user_prompt", {
        payload: { text: "what is this?", blocks: [image, { type: "text", text: "what is this?" }] },
      }),
      validEvent("tool_call", {
        payload: { toolCallId: "toolu_1", toolName: "Read", arguments: { file_path: "shot.png" } },
      }),
      validEvent("tool_result", { payload: { toolCallId: "toolu_1", content: "", blocks: [image] } }),
      validEvent("assistant_text", { payload: { text: "A single pixel." } }),
      validEvent("turn_end"),
    ]);

    const db = openRaw(filePath);
    try {
      // One blob row for the same bytes sent twice.
      const blobs = (db.prepare("SELECT sha256, media_type, byte_length FROM blob").all() as unknown[]).map(loose);
      expect(blobs).toEqual([{ sha256: sha(PNG_B64), media_type: "image/png", byte_length: PNG_LEN }]);
      // No base64 anywhere in text: event payloads, message blocks.
      const marker = PNG_B64.slice(0, 24);
      for (const row of (db.prepare("SELECT payload FROM event").all() as unknown[]).map(loose))
        expect(row.payload).not.toContain(marker);
      for (const row of (db.prepare("SELECT content FROM message_block").all() as unknown[]).map(loose))
        expect(row.content).not.toContain(marker);
      // Block 0 is the text-shaped form with the placeholder; rows 1..n are the API blocks.
      const promptBlocks = (
        db
          .prepare("SELECT block_type, content FROM message_block WHERE message_id = 'm1' ORDER BY block_index")
          .all() as unknown[]
      ).map(loose);
      expect(promptBlocks.map((b) => b.block_type)).toEqual(["text", "image", "text"]);
      expect(JSON.parse(promptBlocks[0]?.content).text).toBe(`${IMAGE_PLACEHOLDER}\nwhat is this?`);
      const resultBlock0 = JSON.parse(
        loose(db.prepare("SELECT content FROM message_block WHERE message_id = 'm3' AND block_index = 0").get())
          .content,
      );
      expect(resultBlock0.content).toBe(IMAGE_PLACEHOLDER);
    } finally {
      db.close();
    }

    // messages.show returns the record with blob references, not bytes.
    const shown = await sdk.messages.show({ filePath }, "m1");
    expect(shown.ok).toBe(true);
    if (shown.ok) expect(JSON.stringify(shown.value)).not.toContain(PNG_B64.slice(0, 24));

    // The served tail carries the real content arrays, base64 back in place.
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const entries = view.value.entries.map(loose);
    const [prompt, assistantCall, result, reply] = [
      entries[0] ?? {},
      entries[1] ?? {},
      entries[2] ?? {},
      entries[3] ?? {},
    ];
    expect(prompt.role).toBe("user");
    expect(prompt.content).toBe(`${IMAGE_PLACEHOLDER}\nwhat is this?`);
    expect(prompt.blocks).toEqual([image, { type: "text", text: "what is this?" }]);
    expect(assistantCall.role).toBe("assistant");
    expect(result.role).toBe("toolResult");
    expect(result.toolName).toBe("Read");
    expect(result.content).toBe(IMAGE_PLACEHOLDER);
    expect(result.blocks).toEqual([image]);
    expect(reply.content[0].text).toBe("A single pixel.");
  });

  it("a PDF document block is a blob with a placeholder that names the title; text-only prompts are unchanged", async () => {
    await intake([
      validEvent("user_prompt", {
        payload: {
          text: "What does section 3 say?",
          blocks: [pdf, { type: "text", text: "What does section 3 say?" }],
        },
      }),
      validEvent("assistant_text", { payload: { text: "It says hello." } }),
      validEvent("turn_end"),
      validEvent("user_prompt", { payload: { text: "plain follow-up" } }),
    ]);
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    if (!view.ok) throw new Error(view.error.reason);
    const entries = view.value.entries.map(loose);
    const [first, plain] = [entries[0] ?? {}, entries[2] ?? {}];
    expect(first.content).toBe("[document · application/pdf · 117 KB · spec.pdf]\nWhat does section 3 say?");
    expect(first.blocks[0]).toEqual(pdf);
    expect(plain.content).toBe("plain follow-up");
    expect(plain.blocks).toBeUndefined();
    const listed = await sdk.messages.list({ filePath }, {});
    if (!listed.ok) throw new Error(listed.error.reason);
    // The document's context cost is counted (≈2,000 tokens a page), not just its placeholder.
    expect(listed.value[0]?.tokenEstimate).toBeGreaterThan(4_000);
  });

  it("redacted thinking and server tool blocks come back inside the assistant entry, verbatim", async () => {
    const redacted = { type: "redacted_thinking", data: "EqQBCkYIBRgCKkD" };
    const serverUse = {
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "web_search",
      input: { query: "lhc" },
      caller: { type: "direct" },
    };
    const serverResult = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      caller: { type: "direct" },
      content: [
        {
          type: "web_search_result",
          title: "LHC",
          url: "https://example.com",
          encrypted_content: "ENC",
          page_age: null,
        },
      ],
    };
    await intake([
      validEvent("user_prompt", { payload: { text: "search" } }),
      validEvent("assistant_thinking", { payload: { text: "", block: redacted } }),
      validEvent("tool_call", {
        payload: { toolCallId: "srvtoolu_1", toolName: "web_search", arguments: { query: "lhc" }, block: serverUse },
      }),
      validEvent("tool_result", { payload: { toolCallId: "srvtoolu_1", content: "", blocks: [serverResult] } }),
      validEvent("assistant_text", { payload: { text: "Found it." } }),
      validEvent("turn_end"),
    ]);
    const view = await sdk.threadView.getSessionThreadView({ filePath });
    if (!view.ok) throw new Error(view.error.reason);
    expect(view.value.entries).toHaveLength(2);
    const assistant = loose(view.value.entries[1]);
    expect(assistant.role).toBe("assistant");
    expect(assistant.content.map((p: Loose) => p.type)).toEqual([
      "redacted_thinking",
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ]);
    expect(assistant.content[0].block).toEqual(redacted);
    expect(assistant.content[1].block).toEqual(serverUse);
    expect(assistant.content[2].block).toEqual(serverResult);
    const db = openRaw(filePath);
    try {
      for (const row of (db.prepare("SELECT content FROM message_block").all() as unknown[]).map(loose))
        expect(row.content).not.toContain('ENC"');
      expect(
        JSON.parse(
          loose(db.prepare("SELECT content FROM message_block WHERE message_id = 'm4' AND block_index = 0").get())
            .content,
        ).content,
      ).toContain("[web search result · 1 result(s)]");
    } finally {
      db.close();
    }
  });

  it("refuses blocks that are not Messages API blocks, wrong for the kind, or not base64", async () => {
    const bad = async (event: MessageEventInput) => {
      const result = await sdk.intakeStream.messageEvents({ filePath }, [event]);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.error.reason;
    };
    expect(
      await bad(validEvent("user_prompt", { payload: { text: "x", blocks: [{ type: "blob", data: "zz" }] } })),
    ).toContain("not a Messages API content block");
    expect(
      await bad(
        validEvent("user_prompt", {
          payload: { text: "x", blocks: [{ type: "tool_use", id: "t", name: "n", input: {} }] },
        }),
      ),
    ).toContain("not allowed here");
    expect(
      await bad(
        validEvent("user_prompt", {
          payload: {
            text: "x",
            blocks: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "not base64!" } }],
          },
        }),
      ),
    ).toContain("must be a base64 string");
    expect(await bad(validEvent("assistant_thinking", { payload: { text: "", block: image } }))).toContain(
      "not allowed here",
    );
  });
});
