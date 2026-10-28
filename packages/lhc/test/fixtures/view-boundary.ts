import type { Lhc, MessageEventInput } from "../../src/index.js";
import { validEvent } from "./index.js";

export function boundaryTokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

let boundaryCallCounter = 0;

export function boundaryToolRun(resultTokens: number): MessageEventInput[] {
  boundaryCallCounter += 1;
  const toolCallId = `call-tb-${boundaryCallCounter}`;
  return [
    validEvent("tool_call", {
      payload: {
        toolCallId,
        toolName: "read_file",
        arguments: { path: `tb-${boundaryCallCounter}.txt` },
      },
    }),
    validEvent("tool_result", {
      payload: { toolCallId, content: boundaryTokens(resultTokens), isError: false },
    }),
  ];
}

export interface TurnedToolResultsSpec {
  results: readonly number[];
  close?: boolean;
}

export function turnedToolResultEvents(turns: readonly TurnedToolResultsSpec[]): MessageEventInput[] {
  const events: MessageEventInput[] = [];
  for (const turn of turns) {
    events.push(validEvent("user_prompt", { payload: { text: "scripted boundary turn" } }));
    for (const n of turn.results) events.push(...boundaryToolRun(n));
    if (turn.close !== false) events.push(validEvent("turn_end"));
  }
  return events;
}

export async function seedTurnedToolResults(
  sdk: Lhc,
  filePath: string,
  turns: readonly TurnedToolResultsSpec[],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents({ filePath }, turnedToolResultEvents(turns));
  if (!result.ok) throw new Error(`boundary seed intake failed: ${result.error.reason}`);
}
