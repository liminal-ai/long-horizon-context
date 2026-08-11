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
