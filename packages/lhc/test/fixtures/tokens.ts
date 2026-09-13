import type { MessageEventInput } from "../../src/intake-stream/index.js";
import * as intakeStream from "../../src/intake-stream/index.js";
import { resolveInstancePoke, runWithInstanceSeam } from "../../src/shared-tech/context.js";
import { TokenEstimator } from "../../src/shared-tech/token-counting/index.js";
import type { ThreadRef } from "../../src/threads/index.js";

/** o200k estimator for tests that assert exact historical token counts. */
export const o200k = new TokenEstimator("o200k");

export function estimateTokens(text: string): number {
  return o200k.estimate(text);
}

export function estimateSignatureTokens(signature: string): number {
  return o200k.estimateSignature(signature);
}

/** Run a below-SDK domain call with an explicit estimator on the instance seam. */
export function withEstimator<T>(estimator: TokenEstimator, fn: () => T): T {
  const poke = resolveInstancePoke();
  return runWithInstanceSeam({ poke, touch: () => {}, tokenEstimator: estimator }, fn);
}

/** Below-SDK intake that constructs the o200k estimator explicitly. */
export function sendMessageEvents(threadRef: ThreadRef, events: readonly MessageEventInput[]) {
  return withEstimator(o200k, () => intakeStream.messageEvents(threadRef, events));
}
