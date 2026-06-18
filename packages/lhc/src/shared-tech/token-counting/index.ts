import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

export const TOKEN_ESTIMATOR_ID = "js-tiktoken:o200k_base";

let encoder: Tiktoken | null = null;

export function estimateTokens(text: string): number {
  if (encoder === null) encoder = new Tiktoken(o200kBase);
  return encoder.encode(text).length;
}
