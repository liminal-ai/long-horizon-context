import { type ExtractedBlob, extractBlobs } from "../../shared-tech/index.js";

export function extractPayloadBlobs<P>(payload: P): { payload: P; blobs: ExtractedBlob[] } {
  if (typeof payload !== "object" || payload === null) return { payload, blobs: [] };
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record["blocks"])) {
    const extracted = extractBlobs(record["blocks"]);
    return { payload: { ...record, blocks: extracted.blocks } as P, blobs: extracted.blobs };
  }
  if (typeof record["block"] === "object" && record["block"] !== null) {
    const extracted = extractBlobs([record["block"]]);
    return { payload: { ...record, block: extracted.blocks[0] } as P, blobs: extracted.blobs };
  }
  return { payload, blobs: [] };
}
