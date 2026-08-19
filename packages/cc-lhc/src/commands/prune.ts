import { runContextMutation, type ContextMutationPlan } from "./context-mutation.js";
import { BUILTIN_CONTEXT_POLICY } from "../governor/config.js";
import type { DispatchOutcome, LhcCommandRuntime } from "./dispatch.js";

function parseTargetTokens(commandLine: string): number | undefined {
  const parts = commandLine.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const parsed = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Manual prune: same settled-seam transaction and (in the wrapper) same handoff
 * as compact. A no-op prune mutates nothing and hands nothing off.
 */
export async function runPruneCommand(commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  const targetTokens = parseTargetTokens(commandLine);
  const plan: ContextMutationPlan = {
    operation: "prune",
    profile: runtime.contextPolicy?.profile ?? BUILTIN_CONTEXT_POLICY.profile,
    lowerBoundTokens: runtime.contextPolicy?.lowerBoundTokens ?? BUILTIN_CONTEXT_POLICY.lowerBoundTokens,
    ...(targetTokens === undefined ? {} : { manualPruneTargetTokens: targetTokens }),
    ...(runtime.hostNotices === undefined || runtime.hostNotices.length === 0
      ? {}
      : { hostNotices: runtime.hostNotices }),
  };
  const outcome = await runContextMutation(plan, runtime);
  if (outcome.kind === "rebuilt") {
    return {
      messages: [
        ...outcome.messages,
        `rebuilt session ${outcome.handoff.rebuilt.sessionId} written; handing off to a fresh Claude child`,
      ],
      handoff: outcome.handoff,
    };
  }
  return { messages: outcome.messages };
}
