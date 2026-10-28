import type { MessageEventInput } from "../../src/intake-stream/index.js";
import * as intakeStream from "../../src/intake-stream/index.js";
import { resolveInstancePoke, runWithInstanceSeam } from "../../src/shared-tech/context.js";
import { TokenEstimator } from "../../src/shared-tech/token-counting/index.js";
import type { ThreadRef } from "../../src/threads/index.js";

export const o200k = new TokenEstimator("o200k");

export function estimateTokens(text: string): number {
  return o200k.estimate(text);
}

export function withEstimator<T>(estimator: TokenEstimator, fn: () => T): T {
  const poke = resolveInstancePoke();
  return runWithInstanceSeam({ poke, touch: () => {}, tokenEstimator: estimator }, fn);
}

export function sendMessageEvents(threadRef: ThreadRef, events: readonly MessageEventInput[]) {
  return withEstimator(o200k, () => intakeStream.messageEvents(threadRef, events));
}
