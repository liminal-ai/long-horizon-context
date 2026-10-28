export interface SamplingRecord {
  model?: string;
  providerUsage?: Record<string, unknown>;
  emitted: boolean;
}

export interface SamplingDedupeState {
  records: Map<string, SamplingRecord>;
}

export function createSamplingDedupeState(): SamplingDedupeState {
  return { records: new Map() };
}

export function samplingIdFromAssistant(input: { requestId?: string; messageId?: string; lineUuid: string }): string {
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
  if (providerUsage !== undefined) next.providerUsage = providerUsage;
  else if (nextUsage !== undefined) next.providerUsage = nextUsage;
  state.records.set(samplingId, next);
}

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
