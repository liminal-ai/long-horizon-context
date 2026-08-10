import { BUILTIN_CONTEXT_POLICY } from "../governor/config.js";
import {
  runContextMutation,
  type ContextMutationPlan,
} from "./context-mutation.js";
import type { DispatchOutcome, LhcCommandRuntime } from "./dispatch.js";

/**
 * Manual compact: same fenced transaction and (in the wrapper) same handoff as
 * automatic compact — only the terminal receipt differs. A due combined prune
 * runs inside the one materialization.
 */
export async function runCompactCommand(_commandLine: string, runtime: LhcCommandRuntime): Promise<DispatchOutcome> {
  const policy = runtime.contextPolicy;
  const plan: ContextMutationPlan = {
    operation: "compact",
    profile: policy?.profile ?? BUILTIN_CONTEXT_POLICY.profile,
    lowerBoundTokens: policy?.lowerBoundTokens ?? BUILTIN_CONTEXT_POLICY.lowerBoundTokens,
    ...(policy?.pruneIfDue === undefined ? {} : { pruneIfDue: policy.pruneIfDue }),
    ...(runtime.inputEpochChanged === undefined ? {} : { inputEpochChanged: runtime.inputEpochChanged }),
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
