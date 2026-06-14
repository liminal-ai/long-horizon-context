import type { MessageEventInput } from "lhc";
import { NotImplementedError } from "../shared/not-implemented.js";

// AC-2.2: track the open LHC turn; emit exactly one `turn_end` at `agent_end`;
// ignore PI's per-step `turn_end` as a boundary signal. Pure state machine.
// Story 2.

export class TurnAccumulator {
  onMessage(events: MessageEventInput[]): void {
    throw new NotImplementedError("capture.TurnAccumulator.onMessage");
  }

  /** Returns `[turn_end]` when a turn is open, else `[]`. */
  onAgentEnd(): MessageEventInput[] {
    throw new NotImplementedError("capture.TurnAccumulator.onAgentEnd");
  }

  hasOpenTurn(): boolean {
    throw new NotImplementedError("capture.TurnAccumulator.hasOpenTurn");
  }
}
