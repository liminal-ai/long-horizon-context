import {
  messages,
  type ResolvedTokenFamily,
  resolveTokenFamily,
  type ThreadRef,
  TokenEstimator,
  type TokenFamily,
  type TokenFamilySource,
} from "lhc";

export const CC_LHC_TOKEN_PROVIDER = "anthropic";

export type TokenFamilySeedSource = "launch --model" | "resumed record" | "provider fallback";

export const TOKEN_FAMILY_STICKY_UNTIL_RELAUNCH = "estimates continue on the previous family until relaunch";

export function defaultSessionTokenFamily(): ResolvedTokenFamily {
  return resolveTokenFamily("", CC_LHC_TOKEN_PROVIDER);
}

export function isRealModelId(modelId: unknown): modelId is string {
  return typeof modelId === "string" && modelId !== "" && !modelId.startsWith("<");
}
export function familyFromAssistantModel(modelId: string): ResolvedTokenFamily {
  return resolveTokenFamily(modelId, CC_LHC_TOKEN_PROVIDER);
}

export interface SessionTokenFamilyState {
  modelId: string | null;
  resolved: ResolvedTokenFamily;
  estimator: TokenEstimator;
  seedSource: TokenFamilySeedSource;
}

export interface TokenFamilyLaunchSeed {
  launchModel?: string;
  resumedAssistantModel?: string | null;
}

export interface AssistantModelRecord {
  kind: string;
  blocks: readonly { content: Record<string, unknown> }[];
}

let defaultEstimator: TokenEstimator | null = null;

export function sessionDefaultEstimator(): TokenEstimator {
  defaultEstimator ??= new TokenEstimator(defaultSessionTokenFamily().family);
  return defaultEstimator;
}

export function createSessionTokenFamilyState(seed?: {
  modelId?: string | null;
  seedSource?: TokenFamilySeedSource;
}): SessionTokenFamilyState {
  const seedSource = seed?.seedSource ?? "provider fallback";
  const modelId = seed?.modelId !== undefined && seed.modelId !== "" ? seed.modelId : null;
  const resolved = modelId === null ? defaultSessionTokenFamily() : familyFromAssistantModel(modelId);
  return {
    modelId,
    resolved,
    estimator: new TokenEstimator(resolved.family),
    seedSource,
  };
}

export function seedTokenFamilyAtLaunch(input: TokenFamilyLaunchSeed = {}): SessionTokenFamilyState {
  const launchModel = input.launchModel?.trim() ?? "";
  if (launchModel !== "") {
    return createSessionTokenFamilyState({ modelId: launchModel, seedSource: "launch --model" });
  }
  const resumed = input.resumedAssistantModel?.trim() ?? "";
  if (resumed !== "") {
    return createSessionTokenFamilyState({ modelId: resumed, seedSource: "resumed record" });
  }
  return createSessionTokenFamilyState({ modelId: null, seedSource: "provider fallback" });
}

export function lastAssistantModelIdFromRecords(records: readonly AssistantModelRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i]!;
    if (rec.kind !== "assistant_text" && rec.kind !== "assistant_thinking") continue;
    const model = rec.blocks[0]?.content["model"];
    if (isRealModelId(model)) return model;
  }
  return null;
}

export async function lastAssistantModelFromThread(threadRef: ThreadRef): Promise<string | null> {
  try {
    const listed = await messages.list(threadRef);
    if (!listed.ok) return null;
    return lastAssistantModelIdFromRecords(listed.value);
  } catch {
    return null;
  }
}

export function formatTokenFamilyLabel(state: Pick<SessionTokenFamilyState, "resolved" | "seedSource">): string {
  return `${state.resolved.family} (${state.seedSource})`;
}

export function formatTokenFamilyChangeLog(
  previous: ResolvedTokenFamily,
  next: ResolvedTokenFamily,
  modelId: string,
): string {
  return `cc-lhc token family: ${previous.family} (${previous.source}) -> ${next.family} (${next.source}) model=${modelId}`;
}

export function noteAssistantModel(state: SessionTokenFamilyState, modelId: string): boolean {
  if (!isRealModelId(modelId)) return false;
  if (modelId === "" || state.modelId === modelId) return false;
  const previous = state.resolved;
  const resolved = familyFromAssistantModel(modelId);
  state.modelId = modelId;
  if (resolved.family !== previous.family) {
    state.estimator = new TokenEstimator(resolved.family);
  }
  state.resolved = resolved;
  return true;
}

export type { ResolvedTokenFamily, TokenFamily, TokenFamilySource };
