import type { TurnUsage } from "claude-code";
import { estimateContent } from "../../src/estimate.ts";

/**
 * The mod's own count of the main loop's context, as Claude Code estimates it
 * before each request: the last response's usage plus its estimate of the
 * content appended since. It runs low by what Claude Code adds without an
 * append carrying it, such as reminder text on an attachment row left empty.
 */
let responded: number | undefined;
let appendedTokens = 0;
let lastCheck: number | undefined;

export function measureAppend(content: unknown): void {
  appendedTokens += estimateContent(content);
}

export function measureResponse(usage: TurnUsage | null): void {
  if (usage === null) return;
  responded = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens;
  appendedTokens = 0;
}

export function measureCompacted(): void {
  responded = undefined;
  lastCheck = undefined;
}

export const contextMeasure = (): number | undefined =>
  responded === undefined ? undefined : responded + appendedTokens;

/** A step starting means Claude Code's check before it did not compact. */
export function measureCheck(): void {
  lastCheck = contextMeasure();
}

export const lastCheckMeasure = (): number | undefined => lastCheck;
