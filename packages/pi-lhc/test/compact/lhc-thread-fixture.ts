import { createDeterministicInferenceCallbacks, initLhc, type Lhc, type MessageEventInput } from "lhc";
import { eventBatch, validEvent } from "../fixtures/synthetic.js";
import type { TempStore } from "../fixtures/thread.js";

const FIXTURE_CHUNK_POLICY = { targetProjectedTokens: 90, maxProjectedTokens: 4400 };

const TURN_COUNT = 12;
const TOOL_HEAVY_TURNS = new Set([5, 6, 7, 8]);

function turnEvents(turn: number): MessageEventInput[] {
  const events: MessageEventInput[] = [
    validEvent("user_prompt", { payload: { text: `turn ${turn}: please investigate area ${turn}` } }),
    validEvent("assistant_thinking", { payload: { text: `considering what area ${turn} contains` } }),
  ];
  if (TOOL_HEAVY_TURNS.has(turn)) {
    for (const run of [1, 2]) {
      const toolCallId = `call-fx-${turn}-${run}`;
      events.push(
        validEvent("tool_call", {
          payload: {
            toolCallId,
            toolName: "read_file",
            arguments: { path: `area-${turn}/file-${run}.txt` },
          },
        }),
        validEvent("tool_result", {
          payload: {
            toolCallId,
            content: `contents of area-${turn}/file-${run}.txt: detail ${turn}.${run} with enough text to summarize`,
            isError: false,
          },
        }),
      );
    }
  }
  events.push(validEvent("assistant_text", { payload: { text: `findings for area ${turn}` } }), validEvent("turn_end"));
  return events;
}

export interface CompactLhcFixture {
  filePath: string;
  sdk: Lhc;
}

export async function buildCompactLhcFixture(store: TempStore): Promise<CompactLhcFixture> {
  const sdk = initLhc({
    inferenceCallbacks: createDeterministicInferenceCallbacks(),
    mode: "manual",
    retry: { budget: 3, backoffBaseMs: 0, backoffCapMs: 0 },
    guards: { smoothTurnCompression: { tinyTurnTokens: 1 } },
    chunkPolicy: FIXTURE_CHUNK_POLICY,
    toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
  });

  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);

  for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
    const recorded = await sdk.intakeStream.messageEvents({ filePath }, turnEvents(turn));
    if (!recorded.ok) throw new Error(recorded.error.reason);
  }

  const drained = await sdk.work.drain({ filePath });
  if (!drained.ok) throw new Error(drained.error.reason);

  return { filePath, sdk };
}

export async function buildAllFitsThread(store: TempStore): Promise<CompactLhcFixture> {
  const sdk = initLhc({ mode: "manual", inferenceCallbacks: createDeterministicInferenceCallbacks() });
  const filePath = store.threadPath();
  const created = await sdk.threads.newThread({ filePath, registryPath: store.registryPath });
  if (!created.ok) throw new Error(created.error.reason);

  const batch: MessageEventInput[] = [];
  for (let turn = 1; turn <= 3; turn += 1) {
    batch.push(...eventBatch(["user_prompt", "assistant_text", "turn_end"]));
  }
  const recorded = await sdk.intakeStream.messageEvents({ filePath }, batch);
  if (!recorded.ok) throw new Error(recorded.error.reason);
  return { filePath, sdk };
}
