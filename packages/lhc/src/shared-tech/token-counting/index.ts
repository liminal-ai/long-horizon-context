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
  return o200kEncoder().encode(text, "all");
}

export interface TokenSlice {
  text: string;
  fromToken: number;
  toToken: number;
  totalTokens: number;
}

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

  rawCount(text: string): number {
    return encodeAll(text).length;
  }

  estimate(text: string): number {
    return this.weigh(this.rawCount(text));
  }

  weigh(rawCount: number): number {
    if (!Number.isFinite(rawCount) || rawCount <= 0) return 0;
    return Math.ceil(rawCount * this.textWeight);
  }

  weighStored(rawCount: number, signatureBilled = 0): number {
    const billed = Math.max(0, signatureBilled);
    return this.weigh(rawCount - billed) + billed;
  }

  estimateSignature(signature: string): number {
    if (signature.length === 0) return 0;
    return Math.ceil(signature.length / this.signatureCharsPerToken);
  }

  toRawIndex(billed: number): number {
    if (!Number.isFinite(billed) || billed <= 0) return 0;
    if (this.textWeight === 1) return Math.floor(billed);
    return Math.floor(billed / this.textWeight);
  }

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
