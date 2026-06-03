import { getEncoding } from "js-tiktoken";

type LocalEncoding = ReturnType<typeof getEncoding>;

const LOCAL_TOKEN_ENCODING = "o200k_base";
const LOCAL_TOKEN_ENCODING_METHOD = "tiktoken:o200k_base";

let cachedEncoding: LocalEncoding | undefined;

function localEncoding(): LocalEncoding {
  cachedEncoding ??= getEncoding(LOCAL_TOKEN_ENCODING);
  return cachedEncoding;
}

export function countLocalTokens(text: string): number {
  return localEncoding().encode(text).length;
}

export function localTokenizerMetadataFields(): {
  source: "local_tokenizer";
  trustClass: "tokenizer_count";
  encodingMethod: "tiktoken:o200k_base";
  tokenizerModel: "o200k_base";
} {
  return {
    source: "local_tokenizer",
    trustClass: "tokenizer_count",
    encodingMethod: LOCAL_TOKEN_ENCODING_METHOD,
    tokenizerModel: LOCAL_TOKEN_ENCODING,
  };
}
