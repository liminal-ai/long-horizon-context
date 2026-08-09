/**
 * Lifecycle sampling fold: one completed sampling attempt → one sampling_observed
 * with the final/verbatim provider usage. Aggregation is lifecycle-only;
 * canonical intake remains per-block in native order.
 *
 * Identity preference (documented):
 * 1. immutable requestId when present on the rollout line
 * 2. assistant message.id
 * 3. line uuid fallback
 *
 * Distinct requestIds are never merged (retries stay separate).
 */

export interface SamplingRecord {
  model?: string;
  providerUsage?: Record<string, unknown>;
  /** True once the completed-attempt fact was published. */
  emitted: boolean;
}

export interface SamplingDedupeState {
  records: Map<string, SamplingRecord>;
}

export function createSamplingDedupeState(): SamplingDedupeState {
  return { records: new Map() };
}

export function samplingIdFromAssistant(input: {
  requestId?: string;
  messageId?: string;
  lineUuid: string;
}): string {
  if (typeof input.requestId === "string" && input.requestId !== "") {
    return `req:${input.requestId}`;
  }
  if (typeof input.messageId === "string" && input.messageId !== "") {
    return input.messageId;
  }
  return `line:${input.lineUuid}`;
}

export type SamplingClaim =
  | { action: "emit"; samplingId: string; model?: string; providerUsage?: Record<string, unknown> }
  | { action: "hold" }
  | { action: "skip" };

/**
 * Accumulate model/usage on a split line. Emit exactly once when the caller
 * marks the sampling attempt complete (terminal content for that API message).
 */
export function noteSamplingPartial(
  state: SamplingDedupeState,
  samplingId: string,
  model: string | undefined,
  providerUsage: Record<string, unknown> | undefined,
): void {
  const existing = state.records.get(samplingId);
  if (existing?.emitted === true) return;
  const next: SamplingRecord = { emitted: false };
  const nextModel = model ?? existing?.model;
  const nextUsage = providerUsage ?? existing?.providerUsage;
  if (nextModel !== undefined) next.model = nextModel;
  // Prefer later usage when provided (final line often has complete tokens).
  if (providerUsage !== undefined) next.providerUsage = providerUsage;
  else if (nextUsage !== undefined) next.providerUsage = nextUsage;
  state.records.set(samplingId, next);
}

/**
 * Publish the single completed sampling_observed for this attempt, if not yet emitted.
 */
export function completeSamplingAttempt(
  state: SamplingDedupeState,
  samplingId: string,
  model: string | undefined,
  providerUsage: Record<string, unknown> | undefined,
): SamplingClaim {
  noteSamplingPartial(state, samplingId, model, providerUsage);
  const rec = state.records.get(samplingId);
  if (rec === undefined) return { action: "skip" };
  if (rec.emitted) return { action: "skip" };
  if (rec.model === undefined && rec.providerUsage === undefined) return { action: "skip" };
  rec.emitted = true;
  state.records.set(samplingId, rec);
  return {
    action: "emit",
    samplingId,
    ...(rec.model !== undefined ? { model: rec.model } : {}),
    ...(rec.providerUsage !== undefined ? { providerUsage: rec.providerUsage } : {}),
  };
}
