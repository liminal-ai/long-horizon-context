import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export const TOKEN_ESTIMATOR_ID = "js-tiktoken:o200k_base";

let encoder: Tiktoken | null = null;

export function estimateTokens(text: string): number {
  if (encoder === null) encoder = new Tiktoken(o200kBase);
  return encoder.encode(text).length;
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
  const tokens = encoder.encode(text);
  const totalTokens = tokens.length;
  const from = Math.max(0, Math.floor(fromToken));
  const to = from >= totalTokens ? from : Math.min(from + Math.floor(maxTokens), totalTokens);
  return { text: encoder.decode(tokens.slice(from, to)), fromToken: from, toToken: to, totalTokens };
}
