// Local declarations of the pi-ai completion surface the connector consumes.
//
// These mirror `@earendil-works/pi-ai` as verified by the wiring research
// (docs/specs/02-pi-lhc/notes/pi-ext-integration-research.md). The pi-ai package
// is not yet a build dependency of this workspace, so the connector declares the
// slice of their contract it touches and swaps to the real imports when the
// dependency lands (Spec Deviation, recorded in the story payload).

import type { AssistantMessage, ModelHandle } from "../pi/types.js";

/** Completion context passed to pi-ai's complete() function. */
export interface CompleteContext {
  systemPrompt?: string;
  messages: Array<{ role: "user"; content: string }>;
}

/** Provider options passed as pi-ai complete()'s third argument. */
export interface CompleteOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/** The pi-ai complete() signature. */
export type PiAiComplete = (
  model: ModelHandle,
  context: CompleteContext,
  options?: CompleteOptions,
) => Promise<AssistantMessage>;

/** Error shapes pi-ai's complete() may throw or return. */
export interface PiAiError {
  code?: string;
  type?: string;
  message?: string;
}

/** Known pi-ai error codes/types that map to LHC failure kinds. */
export const PI_AI_ERROR_CODES = {
  AUTH_FAILED: ["auth_failed", "authentication_error", "unauthorized", "401"],
  INVALID_REQUEST: ["invalid_request", "invalid_api_key", "400"],
  RATE_LIMIT: ["rate_limit", "rate_limit_exceeded", "429"],
  TIMEOUT: ["timeout", "request_timeout", "408"],
  NETWORK: ["network_error", "connection_error", "fetch_error", "ENOTFOUND", "ECONNREFUSED"],
} as const;
