import type { CompactReceipt, OpResult } from "lhc";
import { type BuiltMessage, type CompactAnswer, type CompactRequest, kilo } from "../../src/compact.ts";
import { estimateContent } from "../../src/estimate.ts";
import type { Recorder } from "./capture/recorder.ts";
import { projectView } from "./projector.ts";
import { fingerprintOf } from "./receipts.ts";

/** Claude Code raises `session.compact` between steps: the response is complete, its tools settled, no request sent. */
const ENGINE_SEAM = {
  modelResponseComplete: true,
  requestedToolsSettled: true,
  captureFlushed: true,
  beforeNextProviderRequest: true,
} as const;

const builtTokens = (messages: readonly BuiltMessage[]): number =>
  messages.reduce(
    (sum, message) =>
      sum +
      estimateContent([
        { type: "text", text: message.text },
        ...message.toolUses.map((use) => ({ type: "tool_use", name: use.tool, input: use.input })),
        ...(message.toolResults ?? []).map((result) => ({ type: "text", text: result.text })),
      ]),
    0,
  );

export async function answerCompact(
  recorder: Recorder,
  request: CompactRequest,
  log: (line: string) => void,
): Promise<CompactAnswer> {
  const started = Date.now();
  const recovered = await recorder.recover();
  const { lhc } = recorder.deps;
  const isMidTurn = recorder.isTurnOpen;
  const { target } = request;
  let outcome: string;
  let viewTokens: number | undefined;
  if (request.op === "prune") {
    const pruned = await lhc.threadView.prune(recorder.thread);
    if (!pruned.ok) return { kind: "native", reason: `core prune refused: ${pruned.error.code}: ${pruned.error.reason}` };
    if (pruned.value.noOp) return { kind: "unchanged", reason: "no older tool output is left to shorten" };
    outcome = `pruned ${pruned.value.toolResultsPruned} tool results`;
  } else {
    recorder.receipts.clear();
    const options = { profile: "continuation", params: { lowerBound: target } };
    const compacted: OpResult<CompactReceipt> = isMidTurn
      ? await lhc.threadView.midTurnCompact(recorder.thread, { ...options, seam: ENGINE_SEAM })
      : await lhc.threadView.compact(recorder.thread, options);
    if (!compacted.ok) return { kind: "native", reason: `core compact refused: ${compacted.error.code}: ${compacted.error.reason}` };
    const receipt = compacted.value;
    viewTokens = receipt.totalTokens;
    outcome = `compact point ${receipt.compactPoint} degraded ${receipt.degraded.length} gaps ${receipt.gaps.length}`;
  }
  const view = await lhc.threadView.getSessionThreadView(recorder.thread);
  if (!view.ok) return { kind: "native", reason: `view read failed: ${view.error.reason}` };
  const messages = projectView(view.value);
  if (messages.length === 0) return { kind: "native", reason: "the LHC view is empty" };
  viewTokens ??= builtTokens(messages);
  const { guard } = request;
  // A view that, with Claude Code's fixed overhead, still reaches the trigger reduces nothing and is not installed.
  if (guard !== undefined && viewTokens + guard.fixed >= guard.trigger) {
    return {
      kind: "native",
      reason: `its view of ${kilo(viewTokens)} plus ${kilo(guard.fixed)} of fixed context would not get below the ${kilo(guard.trigger)} trigger`,
    };
  }
  // Only a view the mod installs gets a receipt: recovery matches rows against it.
  recorder.receipts.begin({ sessionId: request.sessionId, cursor: recovered.offset, expected: messages.map(fingerprintOf) });
  log(
    `${request.op ?? "compact"} ${request.trigger} ${isMidTurn ? "mid-turn" : "settled"} view ${viewTokens} tokens (target ${target}) ` +
      `messages ${messages.length} ${outcome} recovered ${recovered.recorded} took ${Date.now() - started}ms`,
  );
  return { kind: "view", messages, isMidTurn, viewTokens };
}
