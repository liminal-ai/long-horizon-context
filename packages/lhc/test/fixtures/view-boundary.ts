// Boundary-test helpers (Epic 05 Story 6): scripted turned tool results for
// the turn-end advance suite. Every seeded turn flows through a REAL
// `intake.messageEvents` commit — no advance surface is invented and no
// boundary is hand-set (Epic 03's anti-shim rule, inherited).
import type { Lhc, MessageEventInput } from "../../src/index.js";
import { validEvent } from "./index.js";

// "tok" tokenizes to exactly one o200k token, joined or leading-space alike,
// so a content of n joined "tok" words carries token_estimate n — the same
// hand-derivable unit the boundary goldens use.
export function boundaryTokens(n: number): string {
  return Array<string>(n).fill("tok").join(" ");
}

let boundaryCallCounter = 0;

// One tool run: call + result with the given token count. No turn framing —
// emitted into a gap, the result records turnless (turn_id NULL).
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

// One scripted turn's worth of tool results, sized in tokens. `close: false`
// leaves the turn open (mid-turn legs); `turnless: true` drops the prompt and
// the turn_end so the results record with no turn membership (DD-10's
// singleton-group legs).
export interface TurnedToolResultsSpec {
  results: readonly number[];
  close?: boolean;
  turnless?: boolean;
}

export function turnedToolResultEvents(
  turns: readonly TurnedToolResultsSpec[],
): MessageEventInput[] {
  const events: MessageEventInput[] = [];
  for (const turn of turns) {
    if (turn.turnless === true) {
      for (const n of turn.results) events.push(...boundaryToolRun(n));
      continue;
    }
    events.push(validEvent("user_prompt", { payload: { text: "scripted boundary turn" } }));
    for (const n of turn.results) events.push(...boundaryToolRun(n));
    if (turn.close !== false) events.push(validEvent("turn_end"));
  }
  return events;
}

// Seed the scripted turns through one real intake batch (one commit, so at
// most one advance check runs — the shape goldens G2 and the multi-turn
// eviction legs need).
export async function seedTurnedToolResults(
  sdk: Lhc,
  filePath: string,
  turns: readonly TurnedToolResultsSpec[],
): Promise<void> {
  const result = await sdk.intakeStream.messageEvents(
    { filePath },
    turnedToolResultEvents(turns),
  );
  if (!result.ok) throw new Error(`boundary seed intake failed: ${result.error.reason}`);
}
