// Epic 05 boundary vocabulary (tech design §Interface Definitions): the one
// function a host supplies, its structured result shapes, and the config that
// arrives at createSdk as the alternative to direct provider injection
// (DD-1, DD-5). LHC treats provider/model strings as opaque routing keys —
// the host's ModelCall implementation is the only code that interprets them.
import type { DerivationType } from "../shared/derivation.js";

/** The one function a host supplies. Single-turn completion; provider/model
 *  are opaque routing keys the host's implementation interprets. (AC-1.2) */
export type ModelCall = (input: ModelCallInput) => Promise<ModelCallResult>;

export interface ModelCallInput {
  provider: string;
  model: string;
  messages: { role: "system" | "user"; content: string }[];
}

export type ModelCallResult =
  | { ok: true; text: string }
  | { ok: false; kind: ModelCallFailureKind; message: string };

/** `empty_output` is adapter-generated (AC-2.4); hosts never return it.
 *  Thrown exceptions classify as `other` (AC-3.3). */
export type ModelCallFailureKind =
  | "rate_limit"
  | "timeout"
  | "network"
  | "empty_output"
  | "other"
  | "auth"
  | "invalid_request";

export interface ModelAssignment {
  provider: string;
  model: string;
  prompt: string; // must name a PROMPT_REGISTRY entry (AC-1.3)
}

/** SdkConfig.inference — the alternative to SdkConfig.provider (DD-5). */
export interface InferenceConfig {
  call: ModelCall;
  assignments: Record<DerivationType, ModelAssignment>; // all seven, validated complete
  timeoutMs?: number; // default 60_000 (DD-6)
  maxInputChars?: number; // default 200_000 (DD-7)
}

/** InferenceConfig after createSdk validation: every optional filled. */
export interface ResolvedInferenceConfig {
  call: ModelCall;
  assignments: Record<DerivationType, ModelAssignment>;
  timeoutMs: number;
  maxInputChars: number;
}
