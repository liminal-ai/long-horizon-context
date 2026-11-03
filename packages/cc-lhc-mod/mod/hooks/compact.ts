import type { EngineInterface, On, SessionCompactInput } from "claude-code";
import { type CompactAnswer, type CompactOp, isReductionInadequate, kilo } from "../../src/compact.ts";
import type { CompactPolicy } from "../../src/settings.ts";
import { contextMeasure, lastCheckMeasure, measureCompacted } from "./measure.ts";
import { currentPolicy } from "./policy.ts";
import { boundSession, drainOutbox, log, post } from "./sidecar.ts";
import { publishBestEffort } from "./state.ts";

let isPressureCheckDue = false;
let requested: CompactOp | undefined;
let unpruned: { isNoOp: boolean; reason: string } | undefined;

/** The op for the next manual `/compact`, the one the panel runs; auto compactions never take it. */
export function requestCompact(op: CompactOp | undefined): void {
  requested = op;
  unpruned = undefined;
}

export const unprunedOutcome = (): { isNoOp: boolean; reason: string } | undefined => unpruned;

function opFor(e: SessionCompactInput): CompactOp {
  if (e.trigger !== "manual" || requested === undefined) return "compact";
  const op = requested;
  requested = undefined;
  return op;
}

async function askForView(
  $: EngineInterface,
  e: SessionCompactInput,
  policy: CompactPolicy,
  fixed: number | undefined,
  op: CompactOp,
): Promise<CompactAnswer> {
  const sessionId = boundSession();
  if (sessionId === undefined) return { kind: "native", reason: "no session is bound" };
  try {
    if (!(await drainOutbox($))) return { kind: "native", reason: "capture could not be flushed to the sidecar" };
    return (await post($, "/compact", {
      sessionId,
      trigger: e.trigger,
      target: policy.target,
      op,
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
    const op = opFor(e);
    const started = Date.now();
    const before = (await $.session.usage()).context.tokens ?? contextMeasure();
    const policy = await currentPolicy($);
    if (e.trigger === "auto") {
      log($, `compact auto dispatch context ${contextMeasure() ?? "unknown"} last check ${lastCheckMeasure() ?? "unknown"} trigger ${policy.trigger}`);
    }
    const fixed = await fixedContext($);
    const answer = await askForView($, e, policy, fixed, op);
    const took = Date.now() - started;
    const at = Date.now();
    const sized = before === undefined ? {} : { before };
    if (op === "prune" && answer.kind !== "view") {
      log($, `prune ${e.trigger} left the context as it was after ${took}ms: ${answer.reason}`);
      unpruned = { isNoOp: answer.kind === "unchanged", reason: answer.reason };
      return { skip: `LHC did not prune: ${answer.reason}` };
    }
    measureCompacted();
    if (answer.kind !== "view") {
      log($, `compact ${e.trigger} fell back to native after ${took}ms: ${answer.reason}`);
      $.ui.log(`LHC could not compact (${answer.reason}). Claude Code's own summary runs instead.`);
      const native = await next(e);
      if (native.skip === undefined) {
        await publishBestEffort($, { lastCompact: { at, op, trigger: e.trigger, ...sized, by: "native", reason: answer.reason }, context: null });
      }
      return native;
    }
    const mode = answer.isMidTurn ? "mid-turn" : "settled";
    log($, `${op} ${e.trigger} ${mode} view ${answer.viewTokens} messages ${answer.messages.length} took ${took}ms`);
    const after = answer.viewTokens + (fixed ?? 0);
    await publishBestEffort($, {
      lastCompact: { at, op, trigger: e.trigger, ...sized, by: "lhc", after, isMidTurn: answer.isMidTurn },
      context: after,
    });
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
