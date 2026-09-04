// Anthropic Messages API content blocks inside LHC. Every block type the API
// defines is held faithfully; the only rewrite is that binary or opaque
// payload strings (base64 image and PDF bytes, redacted-thinking data, web
// search encrypted content) leave the JSON and live in the thread's blob table,
// keyed by content hash. The block keeps the API's shape and names; the payload
// field holds a reference `{ $blob, bytes }` in place of the string. Text never
// carries base64: not in the event payload, not in a message block, not in a
// band, not in a served view unless the caller asks for the block back inlined.
//
// Pure module: no database. Callers extract blobs at intake and inline them at
// serving through the two small functions here.
import { createHash } from "node:crypto";

/** Block type names, as the API spells them. Text-shaped types are stored as
 *  JSON verbatim (no blob); blob-bearing types have their payload paths
 *  extracted. */
export const API_BLOCK_TYPES = [
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "search_result",
  "container_upload",
  "tool_reference",
] as const;
export type ApiBlockType = (typeof API_BLOCK_TYPES)[number];

export type ApiBlock = Record<string, unknown> & { type: string };

export interface BlobRef {
  $blob: string; // "sha256:<hex>"
  bytes: number; // decoded byte length
}

export interface ExtractedBlob {
  sha256: string;
  mediaType: string | null;
  data: Uint8Array;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isApiBlock(value: unknown): value is ApiBlock {
  return (
    isPlainRecord(value) &&
    typeof value["type"] === "string" &&
    (API_BLOCK_TYPES as readonly string[]).includes(value["type"])
  );
}

export function isBlobRef(value: unknown): value is BlobRef {
  return isPlainRecord(value) && typeof value["$blob"] === "string" && typeof value["bytes"] === "number";
}

function blobRefFor(data: Uint8Array): { ref: BlobRef; sha256: string } {
  const sha256 = createHash("sha256").update(data).digest("hex");
  return { ref: { $blob: `sha256:${sha256}`, bytes: data.byteLength }, sha256 };
}

// ── extraction (intake) ──────────────────────────────────────────

interface Sink {
  blobs: ExtractedBlob[];
}

/** A `{type:"base64", media_type, data}` source: data leaves as a blob. Other
 *  source types (url, text, content) are text-shaped or nested. */
function extractSource(source: unknown, sink: Sink): unknown {
  if (!isPlainRecord(source)) return source;
  if (source["type"] === "base64" && typeof source["data"] === "string") {
    const data = Buffer.from(source["data"], "base64");
    const { ref, sha256 } = blobRefFor(data);
    sink.blobs.push({
      sha256,
      mediaType: typeof source["media_type"] === "string" ? source["media_type"] : null,
      data,
    });
    return { ...source, data: ref };
  }
  if (source["type"] === "content" && Array.isArray(source["content"])) {
    return { ...source, content: source["content"].map((inner) => extractBlock(inner, sink)) };
  }
  return source;
}

function extractOpaque(block: Record<string, unknown>, key: string, sink: Sink): Record<string, unknown> {
  const value = block[key];
  if (typeof value !== "string") return block;
  const data = Buffer.from(value, "utf8");
  const { ref, sha256 } = blobRefFor(data);
  sink.blobs.push({ sha256, mediaType: null, data });
  return { ...block, [key]: ref };
}

/** One block, blob payloads extracted, everything else verbatim. Unknown
 *  shapes pass through untouched (a newer API type is still a record). */
function extractBlock(value: unknown, sink: Sink): unknown {
  if (!isPlainRecord(value)) return value;
  switch (value["type"]) {
    case "image":
    case "document":
      return { ...value, source: extractSource(value["source"], sink) };
    case "redacted_thinking":
      return extractOpaque(value, "data", sink);
    case "tool_result":
      return Array.isArray(value["content"])
        ? { ...value, content: value["content"].map((inner) => extractBlock(inner, sink)) }
        : value;
    case "web_search_tool_result":
      return Array.isArray(value["content"])
        ? {
            ...value,
            content: value["content"].map((inner) =>
              isPlainRecord(inner) && inner["type"] === "web_search_result"
                ? extractOpaque(inner, "encrypted_content", sink)
                : inner,
            ),
          }
        : value;
    case "web_fetch_tool_result":
      // content is a web_fetch block whose `content` is a document block.
      return isPlainRecord(value["content"]) && isPlainRecord(value["content"]["content"])
        ? { ...value, content: { ...value["content"], content: extractBlock(value["content"]["content"], sink) } }
        : value;
    default:
      return value;
  }
}

export interface ExtractResult {
  blocks: ApiBlock[];
  blobs: ExtractedBlob[];
}

/** Blocks with their binary/opaque payloads replaced by blob references. */
export function extractBlobs(blocks: readonly unknown[]): ExtractResult {
  const sink: Sink = { blobs: [] };
  const out = blocks.map((block) => extractBlock(block, sink) as ApiBlock);
  return { blocks: out, blobs: sink.blobs };
}

// ── inlining (serving) ───────────────────────────────────────────

export type BlobLoader = (sha256: string) => Uint8Array | undefined;

function inlineValue(value: unknown, load: BlobLoader, encoding: "base64" | "utf8"): unknown {
  if (isBlobRef(value)) {
    const data = load(value.$blob.replace(/^sha256:/, ""));
    if (data === undefined) return value;
    return Buffer.from(data).toString(encoding);
  }
  return value;
}

/** The block as the API shaped it, blob payloads back in place. A blob that
 *  is missing from the store leaves its reference in place rather than
 *  inventing bytes. */
export function inlineBlobs(block: unknown, load: BlobLoader): unknown {
  if (Array.isArray(block)) return block.map((inner) => inlineBlobs(inner, load));
  if (!isPlainRecord(block)) return block;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (isBlobRef(value)) {
      // base64 sources come back as base64; opaque strings (redacted thinking
      // data, encrypted search content) were stored as their utf8 bytes.
      const encoding = key === "data" && block["type"] === "base64" ? "base64" : "utf8";
      out[key] = inlineValue(value, load, encoding);
    } else if (isPlainRecord(value) || Array.isArray(value)) {
      out[key] = inlineBlobs(value, load);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ── text-shaped rendering (bands, derivations, retrieval) ────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceDescription(source: unknown): string {
  if (!isPlainRecord(source)) return "";
  const mediaType = typeof source["media_type"] === "string" ? source["media_type"] : undefined;
  const data = source["data"];
  if (source["type"] === "base64" && isBlobRef(data))
    return [mediaType, formatBytes(data.bytes)].filter(Boolean).join(" · ");
  if (source["type"] === "base64" && typeof data === "string") {
    return [mediaType, formatBytes(Math.floor((data.length * 3) / 4))].filter(Boolean).join(" · ");
  }
  if (source["type"] === "url" && typeof source["url"] === "string") return source["url"];
  if (source["type"] === "text") return "text/plain";
  if (source["type"] === "content") return "content";
  return "";
}

/**
 * What the model needs to know that the block existed, not its content: the
 * API type, media type, size, and a title when the block has one. Text-shaped
 * blocks render their text. Tool-result nesting renders each inner block.
 */
export function placeholderText(block: unknown): string {
  if (!isPlainRecord(block)) return "";
  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string" ? block["text"] : "";
    case "image":
      return `[image · ${sourceDescription(block["source"])}]`;
    case "document": {
      const title = typeof block["title"] === "string" && block["title"] !== "" ? ` · ${block["title"]}` : "";
      const source = block["source"];
      if (isPlainRecord(source) && source["type"] === "text" && typeof source["data"] === "string")
        return source["data"];
      return `[document · ${sourceDescription(source)}${title}]`;
    }
    case "redacted_thinking":
      return "[redacted thinking]";
    case "search_result": {
      const title = typeof block["title"] === "string" ? block["title"] : "";
      const source = typeof block["source"] === "string" ? block["source"] : "";
      const inner = Array.isArray(block["content"]) ? block["content"].map(placeholderText).join("\n") : "";
      return `[search result · ${title} · ${source}]\n${inner}`;
    }
    case "tool_reference":
      return `[tool reference · ${String(block["tool_name"] ?? "")}]`;
    case "container_upload":
      return `[container upload · ${String(block["file_id"] ?? "")}]`;
    case "server_tool_use":
      return `[server tool use · ${String(block["name"] ?? "")}] ${JSON.stringify(block["input"] ?? {})}`;
    case "web_search_tool_result": {
      const content = block["content"];
      if (Array.isArray(content)) {
        const lines = content.map((r) =>
          isPlainRecord(r) ? `- ${String(r["title"] ?? "")} ${String(r["url"] ?? "")}`.trim() : "",
        );
        return `[web search result · ${content.length} result(s)]\n${lines.join("\n")}`;
      }
      return `[web search result] ${JSON.stringify(content ?? {})}`;
    }
    case "web_fetch_tool_result": {
      const content = block["content"];
      const url = isPlainRecord(content) && typeof content["url"] === "string" ? content["url"] : "";
      const doc = isPlainRecord(content) ? placeholderText(content["content"]) : "";
      return `[web fetch result · ${url}]\n${doc}`;
    }
    case "tool_result": {
      const content = block["content"];
      if (typeof content === "string") return content;
      return Array.isArray(content) ? content.map(placeholderText).join("\n") : "";
    }
    default:
      // code_execution_tool_result and friends are text-shaped JSON; anything
      // newer is at least made visible.
      return JSON.stringify(block);
  }
}

/** True when the block carries (or carried) a blob payload. */
export function hasBlobPayload(block: unknown): boolean {
  if (Array.isArray(block)) return block.some(hasBlobPayload);
  if (!isPlainRecord(block)) return false;
  return Object.values(block).some((value) => isBlobRef(value) || hasBlobPayload(value));
}

/**
 * Rough context cost of a block the text estimator cannot see. Images: the
 * API's ceiling for one image (~1,600 tokens at 1568px); PDFs: ~2,000 tokens
 * per page at ~50 KB a page, floor one page. Measured, not calibrated.
 */
export function blobTokenEstimate(block: unknown): number {
  if (!isPlainRecord(block)) return 0;
  const source = block["source"];
  const bytes = isPlainRecord(source) && isBlobRef(source["data"]) ? source["data"].bytes : 0;
  switch (block["type"]) {
    case "image":
      return 1_600;
    case "document":
      return bytes > 0 ? Math.max(1, Math.ceil(bytes / 50_000)) * 2_000 : 0;
    case "tool_result":
      return Array.isArray(block["content"])
        ? block["content"].reduce<number>((sum, inner) => sum + blobTokenEstimate(inner), 0)
        : 0;
    case "web_fetch_tool_result":
      return isPlainRecord(block["content"]) ? blobTokenEstimate(block["content"]["content"]) : 0;
    default:
      return 0;
  }
}
