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
  const window = cleanTailWindow(tokens, from, to - from, totalTokens === to);
  return { text: window.text, fromToken: from, toToken: from + window.count, totalTokens };
}

/** Decode `tokens[from, from + count)` and shrink `count` until the decoded
 *  tail lands on a clean char boundary — BPE token boundaries can split a
 *  multi-byte char, and a split tail would corrupt verbatim text (U+FFFD)
 *  and leave the continuation offset pointing inside a char. `atEnd` windows
 *  reach the text's end and cannot have a split tail. Receipts built from
 *  the returned count always continue at a clean boundary. */
function cleanTailWindow(
  tokens: number[],
  from: number,
  count: number,
  atEnd: boolean,
): { text: string; count: number } {
  let k = Math.max(0, count);
  let text = (encoder as Tiktoken).decode(tokens.slice(from, from + k));
  if (atEnd) return { text, count: k };
  while (k > 0 && text.endsWith("�")) {
    k -= 1;
    text = (encoder as Tiktoken).decode(tokens.slice(from, from + k));
  }
  return { text, count: k };
}

const utf8 = new TextEncoder();

/** UTF-8 byte length without Node Buffer (Convex runtime portability). */
export function utf8ByteLength(text: string): number {
  return utf8.encode(text).length;
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
  const fits = (end: number) => utf8ByteLength((encoder as Tiktoken).decode(tokens.slice(from, end))) <= maxBytes;
  let count = to - from;
  if (!fits(to)) {
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(from + mid)) low = mid;
      else high = mid - 1;
    }
    count = low;
  }
  const window = cleanTailWindow(tokens, from, count, from + count === totalTokens);
  return { text: window.text, fromToken: from, toToken: from + window.count, totalTokens };
}
