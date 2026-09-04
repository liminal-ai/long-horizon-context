/**
 * Generates fixtures/content-blocks-cases.json: TS→Rust parity oracle for
 * shared_tech/content_blocks.rs (extractBlobs, inlineBlobs, placeholderText,
 * blobTokenEstimate, hasBlobPayload). Each case records, as THIS node runtime
 * produces them, the JSON.stringify bytes of the extracted blocks (key order
 * is part of the contract), the blob rows (sha256, mediaType, byteLength),
 * the placeholder line and token estimate per extracted block, and the
 * inlined-back bytes.
 *
 * Regenerate only deliberately (the committed file is the contract):
 *   node scripts/gen-content-blocks-fixtures.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blobTokenEstimate,
  extractBlobs,
  hasBlobPayload,
  inlineBlobs,
  placeholderText,
} from "../../lhc/src/shared-tech/content-blocks.ts";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PDF_B64 = Buffer.from(`%PDF-1.4\n${"x".repeat(60_000)}\n%%EOF`).toString("base64");
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } };
const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF_B64 }, title: "spec.pdf" };

const cases = [
  ["text_only", [{ type: "text", text: "look" }]],
  ["image_pdf_text", [{ type: "text", text: "look" }, image, pdf]],
  ["image_unpadded_base64", [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAECAwQ" } }]],
  ["image_no_media_type_key_order", [{ type: "image", source: { data: PNG_B64, type: "base64" }, cache_control: { type: "ephemeral" } }]],
  ["document_text_source", [{ type: "document", source: { type: "text", media_type: "text/plain", data: "plain body" } }]],
  ["document_url_source", [{ type: "document", source: { type: "url", url: "https://example.com/a.pdf" }, title: "" }]],
  ["document_content_source_nested_image", [{ type: "document", source: { type: "content", content: [{ type: "text", text: "p1" }, image] }, title: "nested" }]],
  // Already-extracted reference (a non-string `data` passes through extraction): exercises the MB spelling without a 2.5 MB payload.
  ["document_big_mb_ref", [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: { $blob: "sha256:0000", bytes: 2_500_000 } } }]],
  ["redacted_thinking", [{ type: "redacted_thinking", data: "EqQBCkYIBRgCKkD" }]],
  ["server_tool_use", [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "lhc", n: 2 } }]],
  ["server_tool_use_no_input", [{ type: "server_tool_use", id: "srvtoolu_2", name: 42 }]],
  ["web_search_result", [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", title: "T", url: "https://x", encrypted_content: "ENCRYPTED", page_age: null }, { type: "web_search_result", title: 7, url: null, encrypted_content: "E2" }, "stray"] }]],
  ["web_search_error", [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } }]],
  ["web_search_null_content", [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: null }]],
  ["web_fetch_document", [{ type: "web_fetch_tool_result", tool_use_id: "srvtoolu_3", content: { type: "web_fetch_result", url: "https://example.com/doc.pdf", retrieved_at: "2026-09-04T00:00:00Z", content: pdf } }]],
  ["web_fetch_text_document", [{ type: "web_fetch_tool_result", tool_use_id: "srvtoolu_4", content: { type: "web_fetch_result", url: "https://example.com/page", content: { type: "document", source: { type: "text", media_type: "text/plain", data: "page text" } } } }]],
  ["tool_result_nested", [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "inner" }, image], is_error: false }]],
  ["tool_result_string", [{ type: "tool_result", tool_use_id: "toolu_1", content: "plain" }]],
  ["search_result", [{ type: "search_result", source: "kb://1", title: "Doc", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], citations: { enabled: true } }]],
  ["tool_reference_container_upload", [{ type: "tool_reference", tool_name: "web_search" }, { type: "container_upload", file_id: "file_1" }, { type: "tool_reference" }]],
  ["code_execution_result", [{ type: "code_execution_tool_result", tool_use_id: "srvtoolu_5", content: { type: "code_execution_result", stdout: "hi\n", stderr: "", return_code: 0, content: [] } }]],
  ["unknown_type_passthrough", [{ type: "future_block", payload: { data: PNG_B64 } }, 3, "s", null]],
  ["thinking_and_tool_use", [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "tool_use", id: "toolu_2", name: "Read", input: { path: "a" } }]],
];

const out = cases.map(([name, input]) => {
  const { blocks, blobs } = extractBlobs(input);
  const store = new Map(blobs.map((b) => [b.sha256, b.data]));
  return {
    name,
    input: JSON.stringify(input),
    extracted: JSON.stringify(blocks),
    blobs: blobs.map((b) => ({ sha256: b.sha256, mediaType: b.mediaType, byteLength: b.data.byteLength })),
    placeholders: blocks.map(placeholderText),
    tokenEstimates: blocks.map(blobTokenEstimate),
    hasBlobPayload: blocks.map(hasBlobPayload),
    inlined: JSON.stringify(inlineBlobs(blocks, (h) => store.get(h))),
    inlinedMissing: JSON.stringify(inlineBlobs(blocks, () => undefined)),
  };
});

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "..", "fixtures", "content-blocks-cases.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${out.length} cases`);
