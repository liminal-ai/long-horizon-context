import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import familiesJson from "./families.json" with { type: "json" };

export const TOKEN_ESTIMATOR_ID = "js-tiktoken:o200k_base";

export type TokenFamily = string;

export interface FamilySpec {
  name: string;
  textWeight: number;
  signatureCharsPerToken: number;
  measured: string;
}

export interface ModelFamilyMatch {
  match: string;
  family: string;
}

export interface FamiliesFile {
  families: Record<string, FamilySpec>;
  models: ModelFamilyMatch[];
  providerFallback: Record<string, string>;
}

export interface FamiliesOverlay {
  families?: Record<string, FamilySpec>;
  models?: ModelFamilyMatch[];
  providerFallback?: Record<string, string>;
}

export type TokenFamilySource = "model" | "provider-fallback" | "unmapped";

export interface ResolvedTokenFamily {
  family: TokenFamily;
  source: TokenFamilySource;
}

export const FAMILIES_CATALOG = familiesJson as FamiliesFile;

const UNMAPPED_FAMILY: TokenFamily = "o200k";

export function mergeFamiliesCatalog(overlay?: FamiliesOverlay): FamiliesFile {
  return {
    families: { ...FAMILIES_CATALOG.families, ...overlay?.families },
    models: [...(overlay?.models ?? []), ...FAMILIES_CATALOG.models],
    providerFallback: { ...FAMILIES_CATALOG.providerFallback, ...overlay?.providerFallback },
  };
}

function familyExists(catalog: FamiliesFile, slug: string): boolean {
  return Object.hasOwn(catalog.families, slug);
}

function matchModel(modelId: string, match: string): boolean {
  return modelId === match || modelId.startsWith(match);
}

export function resolveTokenFamily(modelId: string, provider?: string, overlay?: FamiliesOverlay): ResolvedTokenFamily {
  const catalog = mergeFamiliesCatalog(overlay);
  for (const entry of catalog.models) {
    if (!matchModel(modelId, entry.match)) continue;
    if (!familyExists(catalog, entry.family)) continue;
    return { family: entry.family, source: "model" };
  }
  if (provider !== undefined && provider !== "") {
    const fallback = catalog.providerFallback[provider];
    if (fallback !== undefined && familyExists(catalog, fallback)) {
      return { family: fallback, source: "provider-fallback" };
    }
  }
  return { family: UNMAPPED_FAMILY, source: "unmapped" };
}

let encoder: Tiktoken | null = null;

function o200kEncoder(): Tiktoken {
  if (encoder === null) encoder = new Tiktoken(o200kBase);
  return encoder;
}

function encodeAll(text: string): number[] {
  // Allow all special tokens: captured text is data, and a literal
  // "<|endoftext|>" in a transcript must count, never throw — counting is
  // on the capture path and capture must be total.
  return o200kEncoder().encode(text, "all");
}

export interface TokenSlice {
  text: string;
  fromToken: number;
  toToken: number;
  totalTokens: number;
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
  let text = o200kEncoder().decode(tokens.slice(from, from + k));
  if (atEnd) return { text, count: k };
  while (k > 0 && text.endsWith("\uFFFD")) {
    k -= 1;
    text = o200kEncoder().decode(tokens.slice(from, from + k));
  }
  return { text, count: k };
}

function requireFamilySpec(catalog: FamiliesFile, family: TokenFamily): FamilySpec {
  const spec = catalog.families[family];
  if (spec === undefined) {
    throw new TypeError(`unknown token family "${family}"`);
  }
  if (!Number.isFinite(spec.textWeight) || spec.textWeight <= 0) {
    throw new TypeError(`token family "${family}" textWeight must be finite and > 0, got ${spec.textWeight}`);
  }
  if (!Number.isFinite(spec.signatureCharsPerToken) || spec.signatureCharsPerToken <= 0) {
    throw new TypeError(
      `token family "${family}" signatureCharsPerToken must be finite and > 0, got ${spec.signatureCharsPerToken}`,
    );
  }
  return spec;
}

export class TokenEstimator {
  readonly family: TokenFamily;
  readonly label: string;
  readonly textWeight: number;
  readonly signatureCharsPerToken: number;
  readonly measured: string;

  constructor(family: TokenFamily, overlay?: FamiliesOverlay) {
    const spec = requireFamilySpec(mergeFamiliesCatalog(overlay), family);
    this.family = family;
    this.label = spec.name;
    this.textWeight = spec.textWeight;
    this.signatureCharsPerToken = spec.signatureCharsPerToken;
    this.measured = spec.measured;
  }

  /** Unweighted o200k_base count. This is what `message.token_estimate` stores. */
  rawCount(text: string): number {
    return encodeAll(text).length;
  }

  /** Billed-token estimate: ceil(o200k count × family textWeight). */
  estimate(text: string): number {
    return this.weigh(this.rawCount(text));
  }

  /** Apply the family weight to a stored o200k count. Does not re-scale billed signature tokens. */
  weigh(rawCount: number): number {
    if (!Number.isFinite(rawCount) || rawCount <= 0) return 0;
    return Math.ceil(rawCount * this.textWeight);
  }

  /**
   * Budget a stored `token_estimate` that may include billed signature tokens.
   * `signatureBilled` is already at the family signature rate and is added back
   * unweighted. Pass 0 when the stored number is text-only.
   */
  weighStored(rawCount: number, signatureBilled = 0): number {
    const billed = Math.max(0, signatureBilled);
    return this.weigh(rawCount - billed) + billed;
  }

  /** ceil(signature.length / family signatureCharsPerToken). Empty → 0. */
  estimateSignature(signature: string): number {
    if (signature.length === 0) return 0;
    return Math.ceil(signature.length / this.signatureCharsPerToken);
  }

  /** Convert a billed-token index/count into the o200k index used to cut text. */
  toRawIndex(billed: number): number {
    if (!Number.isFinite(billed) || billed <= 0) return 0;
    if (this.textWeight === 1) return Math.floor(billed);
    return Math.floor(billed / this.textWeight);
  }

  /**
   * Exact token window of `text`. The cut is still o200k-based; `fromToken`,
   * `maxTokens`, and the reported counts are in billed (weighted) units so a
   * remaining budget from `estimate()` is the same unit.
   */
  sliceTokens(text: string, fromToken: number, maxTokens: number): TokenSlice {
    const tokens = encodeAll(text);
    const totalRaw = tokens.length;
    const fromRaw = Math.max(0, this.toRawIndex(fromToken));
    const maxRaw = Math.max(0, this.toRawIndex(maxTokens));
    const toRaw = fromRaw >= totalRaw ? fromRaw : Math.min(fromRaw + maxRaw, totalRaw);
    const window = cleanTailWindow(tokens, fromRaw, toRaw - fromRaw, totalRaw === toRaw);
    return {
      text: window.text,
      fromToken: this.weigh(fromRaw),
      toToken: this.weigh(fromRaw + window.count),
      totalTokens: this.weigh(totalRaw),
    };
  }

  /** `sliceTokens` that also fits a UTF-8 byte allowance: encode ONCE, take the
   *  token window, and when its bytes exceed `maxBytes` binary-search the
   *  largest token count whose decoded slice fits. Receipts stay token-
   *  denominated — bytes only shrink how much is served now. Single encode:
   *  probing decodes token subranges, never re-encodes (long-run BPE pieces
   *  make re-encoding quadratic). */
  sliceTokensByteCapped(text: string, fromToken: number, maxTokens: number, maxBytes: number): TokenSlice {
    const tiktoken = o200kEncoder();
    const tokens = encodeAll(text);
    const totalRaw = tokens.length;
    const fromRaw = Math.max(0, this.toRawIndex(fromToken));
    const maxRaw = Math.max(0, this.toRawIndex(maxTokens));
    const toRaw = fromRaw >= totalRaw ? fromRaw : Math.min(fromRaw + maxRaw, totalRaw);
    const fits = (end: number) => Buffer.byteLength(tiktoken.decode(tokens.slice(fromRaw, end)), "utf8") <= maxBytes;
    let count = toRaw - fromRaw;
    if (!fits(toRaw)) {
      let low = 0;
      let high = count;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(fromRaw + mid)) low = mid;
        else high = mid - 1;
      }
      count = low;
    }
    const window = cleanTailWindow(tokens, fromRaw, count, fromRaw + count === totalRaw);
    return {
      text: window.text,
      fromToken: this.weigh(fromRaw),
      toToken: this.weigh(fromRaw + window.count),
      totalTokens: this.weigh(totalRaw),
    };
  }
}

/** Billed signature tokens from projected/stored blocks. 0 when absent or empty. */
export function billedSignatureTokens(
  estimator: TokenEstimator,
  blocks: ReadonlyArray<{ content?: Record<string, unknown> }>,
): number {
  for (const block of blocks) {
    const signature = block.content?.["signature"];
    if (typeof signature === "string" && signature.length > 0) {
      return estimator.estimateSignature(signature);
    }
  }
  return 0;
}
