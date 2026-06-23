import type { MessageEventInput } from "lhc";
import { eventKey } from "./idempotency.js";

// Track the open LHC turn; emit exactly one `turn_end` at `agent_end`; ignore
// PI's per-step `turn_end` as a boundary signal. Pure state machine.
//
// An LHC turn opens on a `user_prompt` and stays open across every agent step.
// The converter never feeds PI's per-step `turn_end` here, so it can never close
// a turn; only `onAgentEnd()` does, and only when a turn is open. A run that
// never reaches `agent_end` (hard kill) leaves the turn open — tolerated as a
// no-op on reattach, since a fresh accumulator has no open turn to close.

export interface TurnAccumulatorCtx {
  piSessionId: string;
  actor?: string;
  harness?: string;
}

export class TurnAccumulator {
  private readonly piSessionId: string;
  private readonly actor: string;
  private readonly harness: string;
  private open = false;
  private openTurnKey: string | null = null;

  constructor(ctx: TurnAccumulatorCtx) {
    this.piSessionId = ctx.piSessionId;
    this.actor = ctx.actor ?? "system";
    this.harness = ctx.harness ?? "pi";
  }

  /** Open the turn when this message's events include a `user_prompt`. A new
   *  prompt mid-run is handled by LHC's own turn machine (close-then-open); the
   *  accumulator only needs to know a turn is open for the `agent_end` close. */
  onMessage(events: MessageEventInput[]): void {
    const opening = events.find((event) => event.eventKind === "user_prompt");
    if (opening !== undefined) {
      this.open = true;
      this.openTurnKey = opening.idempotencyKey;
    }
  }

  /** Returns `[turn_end]` when a turn is open, else `[]`. Closing is the only
   *  transition the accumulator drives, and it happens once per agent run. */
  onAgentEnd(): MessageEventInput[] {
    if (!this.open) return [];
    this.open = false;
    const key = eventKey({
      piSessionId: this.piSessionId,
      blockIndex: 0,
      kind: "turn_end",
      role: "system",
      content: this.openTurnKey ?? "turn:end",
    });
    this.openTurnKey = null;
    return [
      {
        eventKind: "turn_end",
        idempotencyKey: key,
        actor: this.actor,
        harness: this.harness,
        payload: {},
      },
    ];
  }

  hasOpenTurn(): boolean {
    return this.open;
  }
}
