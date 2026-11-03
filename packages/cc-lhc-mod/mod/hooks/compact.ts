import type { EngineInterface, On, SessionCompactInput } from "claude-code";
import { type CompactAnswer, isReductionInadequate, kilo } from "../../src/compact.ts";
import type { CompactPolicy } from "../../src/settings.ts";
import { contextMeasure, lastCheckMeasure, measureCompacted } from "./measure.ts";
import { currentPolicy } from "./policy.ts";
import { boundSession, drainOutbox, log, post } from "./sidecar.ts";

let isPressureCheckDue = false;

async function askForView(
  $: EngineInterface,
  e: SessionCompactInput,
  policy: CompactPolicy,
  fixed: number | undefined,
): Promise<CompactAnswer> {
  const sessionId = boundSession();
  if (sessionId === undefined) return { kind: "native", reason: "no session is bound" };
  try {
    if (!(await drainOutbox($))) return { kind: "native", reason: "capture could not be flushed to the sidecar" };
    return (await post($, "/compact", {
      sessionId,
      trigger: e.trigger,
      target: policy.target,
      ...(fixed === undefined ? {} : { guard: { trigger: policy.trigger, fixed } }),
    })) as CompactAnswer;
  } catch (error) {
    return { kind: "native", reason: String(error) };
  }
}

async function checkPressure($: EngineInterface, policy: CompactPolicy): Promise<void> {
  const tokens = (await $.session.usage({ breakdown: "summary" })).context.breakdown?.totalTokens;
  if (tokens === undefined) return;
  const isInadequate = isReductionInadequate(tokens, policy.trigger);
  log($, `post-compact context ${tokens} trigger ${policy.trigger} target ${policy.target} ${isInadequate ? "inadequate" : "ok"}`);
  if (isInadequate) {
    $.ui.log(
      `LHC: context is ${kilo(tokens)} right after compacting, close to the ${kilo(policy.trigger)} trigger. ` +
        "Claude Code may stop this turn if the next steps refill it. Lower the target or raise the trigger in the LHC settings.",
    );
  }
}

/**
 * What the engine counts beside the conversation: its breakdown's `used` rows
 * other than the messages. Re-attached reminders count as messages, so this
 * errs low; undefined when the breakdown names no messages row.
 */
async function fixedContext($: EngineInterface): Promise<number | undefined> {
  const categories = (await $.session.usage({ breakdown: "summary" })).context.breakdown?.categories ?? [];
  if (!categories.some((category) => category.name === "Messages")) return undefined;
  const fixed = categories
    .filter((category) => category.kind === "used" && category.name !== "Messages")
    .reduce((sum, category) => sum + category.tokens, 0);
  log($, `fixed context ${fixed}`);
  return fixed;
}

export function registerCompact(on: On): void {
  on("session.compact", async ($, e, next) => {
    if (e.trigger === "precompute") return { skip: "LHC builds its view when the compaction runs" };
    if (e.agentId !== undefined) return next(e);
    const started = Date.now();
    const before = (await $.session.usage()).context.tokens;
    const policy = await currentPolicy($);
    if (e.trigger === "auto") {
      log($, `compact auto dispatch context ${contextMeasure() ?? "unknown"} last check ${lastCheckMeasure() ?? "unknown"} trigger ${policy.trigger}`);
    }
    measureCompacted();
    const answer = await askForView($, e, policy, await fixedContext($));
    const took = Date.now() - started;
    if (answer.kind === "native") {
      log($, `compact ${e.trigger} fell back to native after ${took}ms: ${answer.reason}`);
      $.ui.log(`LHC could not compact (${answer.reason}). Claude Code's own summary runs instead.`);
      $.ui.status("LHC fell back to Claude Code's summary at the last compaction");
      return next(e);
    }
    const mode = answer.isMidTurn ? "mid-turn" : "settled";
    const from = before === undefined ? "" : `${kilo(before)} `;
    log($, `compact ${e.trigger} ${mode} view ${answer.viewTokens} messages ${answer.messages.length} took ${took}ms`);
    $.ui.status(`LHC compacted ${from}to ${kilo(answer.viewTokens)} (${mode})`);
    if (e.instructions !== undefined && e.instructions.trim() !== "") {
      $.ui.log("LHC recorded your /compact instructions as a note. Its view comes from the record, so they were not applied.");
    }
    isPressureCheckDue = true;
    return {
      messages: answer.messages,
      tokensAfter: answer.viewTokens,
      ...(before === undefined ? {} : { tokensBefore: before }),
    };
  });
}

export async function checkPressureOnce($: EngineInterface, policy: CompactPolicy | undefined): Promise<void> {
  if (!isPressureCheckDue || policy === undefined) return;
  isPressureCheckDue = false;
  await checkPressure($, policy).catch((error: unknown) => log($, `pressure check failed: ${String(error)}`));
}
