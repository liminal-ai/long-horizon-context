import type { EngineInterface, ModelCompleteResult } from "claude-code";
import type { BridgeOutcome, BridgeRequest } from "../../src/inference.ts";
import { log, post } from "./sidecar.ts";

const PUMP_MS = 1000;

let isPumping = false;
let isClaiming = false;

function outcomeOf(result: ModelCompleteResult): BridgeOutcome {
  if (result.isAnswered) return { isAnswered: true, text: result.text };
  if (result.reason === "api-error") return { isAnswered: false, reason: "api-error", status: result.status, error: result.error };
  return result.reason === "empty-reply" ? { isAnswered: false, reason: "empty-reply" } : { isAnswered: false, reason: "aborted" };
}

async function run($: EngineInterface, request: BridgeRequest): Promise<void> {
  const started = Date.now();
  log($, `bridge ${request.id} ${request.model} claimed`);
  const outcome = await $.model
    .complete({
      model: request.model,
      system: request.system,
      prompt: request.prompt,
      maxTokens: request.maxTokens,
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    })
    .then(outcomeOf, (error: unknown): BridgeOutcome => {
      log($, `bridge ${request.id} refused by the engine: ${String(error)}`);
      return { isAnswered: false, reason: "api-error", status: null, error: "invalid_request" };
    });
  const how = outcome.isAnswered ? "answered" : outcome.reason;
  log($, `bridge ${request.id} ${request.model} ${how} in ${Date.now() - started}ms`);
  await post($, "/inference/result", { id: request.id, outcome });
}

async function claim($: EngineInterface): Promise<void> {
  if (isClaiming) return;
  isClaiming = true;
  try {
    const { requests } = (await post($, "/inference/claim", {})) as { requests: BridgeRequest[] };
    for (const request of requests) {
      void run($, request).catch((error: unknown) => log($, `bridge ${request.id} result not posted: ${String(error)}`));
    }
  } finally {
    isClaiming = false;
  }
}

export function startInferencePump($: EngineInterface): void {
  if (isPumping) return;
  isPumping = true;
  $.clock.every(PUMP_MS, () => {
    void claim($).catch(() => {});
  });
}
