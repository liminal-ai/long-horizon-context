import type { CompactReceipt, OpResult } from "lhc";
import type { CompactAnswer, CompactRequest } from "../../src/compact.ts";
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

export async function answerCompact(
  recorder: Recorder,
  request: CompactRequest,
  log: (line: string) => void,
): Promise<CompactAnswer> {
  const started = Date.now();
  const recovered = await recorder.recover();
  recorder.receipts.clear();
  const { lhc } = recorder.deps;
  const isMidTurn = recorder.isTurnOpen;
  const { target } = request;
  const options = { profile: "continuation", params: { lowerBound: target } };
  const compacted: OpResult<CompactReceipt> = isMidTurn
    ? await lhc.threadView.midTurnCompact(recorder.thread, { ...options, seam: ENGINE_SEAM })
    : await lhc.threadView.compact(recorder.thread, options);
  if (!compacted.ok) return { kind: "native", reason: `core compact refused: ${compacted.error.code}: ${compacted.error.reason}` };
  const view = await lhc.threadView.getSessionThreadView(recorder.thread);
  if (!view.ok) return { kind: "native", reason: `view read failed: ${view.error.reason}` };
  const messages = projectView(view.value);
  if (messages.length === 0) return { kind: "native", reason: "the LHC view is empty" };
  recorder.receipts.begin({ sessionId: request.sessionId, cursor: recovered.offset, expected: messages.map(fingerprintOf) });
  const receipt = compacted.value;
  log(
    `compact ${request.trigger} ${isMidTurn ? "mid-turn" : "settled"} view ${receipt.totalTokens} tokens (target ${target}) ` +
      `messages ${messages.length} compact point ${receipt.compactPoint} degraded ${receipt.degraded.length} gaps ${receipt.gaps.length} ` +
      `recovered ${recovered.recorded} took ${Date.now() - started}ms`,
  );
  return { kind: "view", messages, isMidTurn, viewTokens: receipt.totalTokens };
}
