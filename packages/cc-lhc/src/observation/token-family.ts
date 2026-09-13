/**
 * Session token-family state for cc-lhc.
 *
 * The capture SDK is constructed once per process with the family known at
 * launch. Seed order, before initLhc: (1) child argv `--model`; (2) on a
 * resume, the last recorded assistant model id in the thread record; (3) the
 * Anthropic provider fallback (`claude-2026`). A later model-id change is one
 * log line and does not recreate the SDK; estimates stay on the launch family
 * until relaunch.
 */

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

/** How this process chose the family it constructed the SDK with. */
export type TokenFamilySeedSource = "launch --model" | "resumed record" | "provider fallback";

export const TOKEN_FAMILY_STICKY_UNTIL_RELAUNCH = "estimates continue on the previous family until relaunch";

export function defaultSessionTokenFamily(): ResolvedTokenFamily {
  return resolveTokenFamily("", CC_LHC_TOKEN_PROVIDER);
}

export function familyFromAssistantModel(modelId: string): ResolvedTokenFamily {
  return resolveTokenFamily(modelId, CC_LHC_TOKEN_PROVIDER);
}

export interface SessionTokenFamilyState {
  /** Last assistant model id observed or seeded; null when the seed had none. */
  modelId: string | null;
  resolved: ResolvedTokenFamily;
  estimator: TokenEstimator;
  /** Why this process's SDK family was chosen. Unchanged after launch. */
  seedSource: TokenFamilySeedSource;
}

export interface TokenFamilyLaunchSeed {
  /** `--model` value from the child argv, when present. */
  launchModel?: string;
  /** Last assistant model id from the resumed thread record, when present. */
  resumedAssistantModel?: string | null;
}

export interface AssistantModelRecord {
  kind: string;
  blocks: readonly { content: Record<string, unknown> }[];
}

let defaultEstimator: TokenEstimator | null = null;

/** Estimator for the provider-fallback family; used before a session has one. */
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

/**
 * Seed the process family before initLhc. `--model` wins; else a resume
 * record; else the provider fallback.
 */
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

/** Last non-empty `model` on an assistant_text / assistant_thinking row. */
export function lastAssistantModelIdFromRecords(records: readonly AssistantModelRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const rec = records[i]!;
    if (rec.kind !== "assistant_text" && rec.kind !== "assistant_thinking") continue;
    const model = rec.blocks[0]?.content["model"];
    if (typeof model === "string" && model !== "") return model;
  }
  return null;
}

/** Last recorded assistant model id in a resumed thread, or null if none/unreadable. */
export async function lastAssistantModelFromThread(threadRef: ThreadRef): Promise<string | null> {
  try {
    const listed = await messages.list(threadRef);
    if (!listed.ok) return null;
    return lastAssistantModelIdFromRecords(listed.value);
  } catch {
    return null;
  }
}

/** `/details` Family value and compact-note parenthetical: `claude-2025 (launch --model)`. */
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

/**
 * Re-resolve from a captured assistant model id. Returns whether the model id
 * changed (the caller logs that; nothing else happens).
 */
export function noteAssistantModel(state: SessionTokenFamilyState, modelId: string): boolean {
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
