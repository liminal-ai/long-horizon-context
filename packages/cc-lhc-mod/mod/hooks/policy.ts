import type { EngineInterface } from "claude-code";
import { type CompactPolicy, computePolicy, type ResolvedSettings, resolveSettings } from "../../src/settings.ts";
import { log, post, runInBackground } from "./sidecar.ts";

let options: Record<string, unknown> = {};
let settings: ResolvedSettings = resolveSettings(options);
let appliedModel: string | undefined;
let applied: CompactPolicy | undefined;

async function compactWindow($: EngineInterface): Promise<number> {
  const { context } = await $.session.usage({ breakdown: "summary" });
  return context.breakdown?.rawMaxTokens ?? context.window;
}

export async function currentPolicy($: EngineInterface): Promise<CompactPolicy> {
  return applied ?? computePolicy(settings, await compactWindow($)).policy;
}

export function setOptions(next: Record<string, unknown>): void {
  options = { ...next };
  settings = resolveSettings(options);
}

export function setOption(field: string, value: unknown): void {
  setOptions({ ...options, [field]: value });
}

export const appliedPolicy = (): CompactPolicy | undefined => applied;

export async function hasModelChanged($: EngineInterface): Promise<boolean> {
  return appliedModel !== undefined && (await $.session.model()) !== appliedModel;
}

export function applySettings($: EngineInterface, reason: string): void {
  void runInBackground($, "applySettings", async () => {
    appliedModel = await $.session.model();
    const { policy, notices } = computePolicy(settings, await compactWindow($));
    for (const notice of notices) $.ui.log(`LHC settings: ${notice}`);
    const set = await $.env.set("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", String(policy.pct));
    if ("deny" in set) throw new Error(`env refused: ${set.deny}`);
    applied = policy;
    const clamp = policy.isClamped ? " clamped" : "";
    log(
      $,
      `${reason} window ${policy.window} trigger ${policy.trigger} target ${policy.target} pct ${policy.pct}${clamp}`,
    );
    await post($, "/policy", { window: policy.window, trigger: policy.trigger, target: policy.target });
  });
}
