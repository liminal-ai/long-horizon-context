// The one place an event payload's content blocks are rewritten: binary and
// opaque payload strings leave for the blob table and `{ $blob, bytes }`
// references take their place. Which payload keys carry blocks is fixed by the
// intake types (`blocks` on user_prompt and tool_result, `block` on
// assistant_thinking and tool_call); everything else passes through untouched.
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
