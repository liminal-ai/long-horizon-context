import { createHash } from "node:crypto";

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
  $blob: string;
  bytes: number;
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

interface Sink {
  blobs: ExtractedBlob[];
}

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

export function extractBlobs(blocks: readonly unknown[]): ExtractResult {
  const sink: Sink = { blobs: [] };
  const out = blocks.map((block) => extractBlock(block, sink) as ApiBlock);
  return { blocks: out, blobs: sink.blobs };
}

export type BlobLoader = (sha256: string) => Uint8Array | undefined;

function inlineValue(value: unknown, load: BlobLoader, encoding: "base64" | "utf8"): unknown {
  if (isBlobRef(value)) {
    const data = load(value.$blob.replace(/^sha256:/, ""));
    if (data === undefined) return value;
    return Buffer.from(data).toString(encoding);
  }
  return value;
}

export function inlineBlobs(block: unknown, load: BlobLoader): unknown {
  if (Array.isArray(block)) return block.map((inner) => inlineBlobs(inner, load));
  if (!isPlainRecord(block)) return block;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (isBlobRef(value)) {
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
      return JSON.stringify(block);
  }
}

export function hasBlobPayload(block: unknown): boolean {
  if (Array.isArray(block)) return block.some(hasBlobPayload);
  if (!isPlainRecord(block)) return false;
  return Object.values(block).some((value) => isBlobRef(value) || hasBlobPayload(value));
}

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
