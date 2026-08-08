import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export const TOKEN_ESTIMATOR_ID = "js-tiktoken:o200k_base";

let encoder: Tiktoken | null = null;

export function estimateTokens(text: string): number {
  if (encoder === null) encoder = new Tiktoken(o200kBase);
  // Allow all special tokens: captured text is data, and a literal
  // "<|endoftext|>" in a transcript must count, never throw — counting is
  // on the capture path and capture must be total.
  return encoder.encode(text, "all").length;
}

export interface TokenSlice {
  text: string;
  fromToken: number;
  toToken: number;
  totalTokens: number;
}

/** Exact token window of `text`: encode, slice `[fromToken, fromToken + maxTokens)`,
 *  decode. A past-the-end offset returns an empty slice that preserves the
 *  requested offset, so the caller's receipt can name what was actually asked. */
export function sliceTokens(text: string, fromToken: number, maxTokens: number): TokenSlice {
  if (encoder === null) encoder = new Tiktoken(o200kBase);
  const tokens = encoder.encode(text, "all");
  const totalTokens = tokens.length;
  const from = Math.max(0, Math.floor(fromToken));
  const to = from >= totalTokens ? from : Math.min(from + Math.floor(maxTokens), totalTokens);
  return { text: encoder.decode(tokens.slice(from, to)), fromToken: from, toToken: to, totalTokens };
}

/** `sliceTokens` that also fits a UTF-8 byte allowance: encode ONCE, take the
 *  token window, and when its bytes exceed `maxBytes` binary-search the
 *  largest token count whose decoded slice fits. Receipts stay token-
 *  denominated — bytes only shrink how much is served now. Single encode:
 *  probing decodes token subranges, never re-encodes (long-run BPE pieces
 *  make re-encoding quadratic). */
export function sliceTokensByteCapped(
  text: string,
  fromToken: number,
  maxTokens: number,
  maxBytes: number,
): TokenSlice {
  if (encoder === null) encoder = new Tiktoken(o200kBase);
  const tokens = encoder.encode(text, "all");
  const totalTokens = tokens.length;
  const from = Math.max(0, Math.floor(fromToken));
  const to = from >= totalTokens ? from : Math.min(from + Math.floor(maxTokens), totalTokens);
  const decodeRange = (end: number) => encoder!.decode(tokens.slice(from, end));
  let sliceText = decodeRange(to);
  if (Buffer.byteLength(sliceText, "utf8") <= maxBytes) {
    return { text: sliceText, fromToken: from, toToken: to, totalTokens };
  }
  let low = 0;
  let high = to - from;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(decodeRange(from + mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  sliceText = decodeRange(from + low);
  return { text: sliceText, fromToken: from, toToken: from + low, totalTokens };
}
