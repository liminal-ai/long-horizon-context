import type { MessageEventInput } from "lhc";
import type { AgentMessage, AssistantMessage, PiStopReason } from "../pi/types.js";
import { eventKey } from "./idempotency.js";

type TurnEndPayload = Extract<MessageEventInput, { eventKind: "turn_end" }>["payload"];

// Track the open LHC turn; emit exactly one `turn_end` at `agent_end`; ignore
// PI's per-step `turn_end` as a boundary signal. Pure state machine.
//
// An LHC turn opens on a `user_prompt` and stays open across every agent step.
// The converter never feeds PI's per-step `turn_end` here, so it can never close
// a turn; only `onAgentEnd()` does, and only when a turn is open. A run that
// never reaches `agent_end` (hard kill) leaves the turn open — tolerated as a
// no-op on reattach, since a fresh accumulator has no open turn to close.
// Hard-kill therefore records no `turn_end` and leaves outcome/timing NULL —
// correct under schema v5 D2 (unknown, not fabricated).
//
// Host facts on `turn_end` (schema v5): `startedAt` latches from the first
// message timestamp of the LHC turn; `endedAt` is the last message's timestamp
// (message-record time, never wall-clock at close — determinism for replay);
// `outcome` / `outcomeReason` derive from the final assistant `stopReason` at
// `agent_end` (final state governs: a mid-turn abort that continued and ended
// clean is `completed`).
//
// Step index (turn parts, F2): one step is one provider request/response
// cycle. PI's per-step `turn_end` — still never a turn boundary — advances the
// counter; the counter resets to 0 on every prompt (LHC opens a turn per
// prompt). `currentStep()` is the host fact stamped on the step-bearing
// events queued while a turn is open; with no open turn it is null and the
// record keeps NULL (never split) — reattach onto a turn a prior process left
// open, and every pre-existing thread, stay unsplittable.

export interface TurnAccumulatorCtx {
  piSessionId: string;
  actor?: string;
  harness?: string;
}

/** Optional end-of-run facts. Live capture passes `agent_end.messages`; when
 *  absent (unit tests / corpus agent_end without messages), latched per-message
 *  state from `onMessage` is used. */
export interface AgentEndFacts {
  messages?: readonly AgentMessage[];
}

function isoFromEpochMs(ms: number): string {
  return new Date(ms).toISOString();
}

function mapStopReason(
  stopReason: PiStopReason | undefined,
  errorMessage: string | undefined,
): Pick<TurnEndPayload, "outcome" | "outcomeReason"> {
  if (stopReason === undefined) return {};
  switch (stopReason) {
    case "stop":
    case "toolUse":
      return { outcome: "completed" };
    case "length":
      return { outcome: "completed", outcomeReason: "length" };
    case "error":
      return {
        outcome: "aborted",
        outcomeReason: errorMessage !== undefined && errorMessage !== "" ? errorMessage : "error",
      };
    case "aborted":
      return { outcome: "aborted", outcomeReason: "aborted" };
    default:
      return {};
  }
}

function isAssistant(msg: AgentMessage): msg is AssistantMessage {
  return msg.role === "assistant";
}

export class TurnAccumulator {
  private readonly piSessionId: string;
  private readonly actor: string;
  private readonly harness: string;
  private open = false;
  private openTurnKey: string | null = null;
  /** Epoch ms of the first message in the open LHC turn (typically the opening user prompt). */
  private startedAtMs: number | null = null;
  /** Epoch ms of the most recent message seen while the turn is open. */
  private lastTimestampMs: number | null = null;
  /** Last assistant stopReason/errorMessage latched from message_end (fallback when agent_end has no messages). */
  private lastStopReason: PiStopReason | undefined;
  private lastErrorMessage: string | undefined;
  /** Host step index of the in-flight provider cycle of the open turn. */
  private step = 0;

  constructor(ctx: TurnAccumulatorCtx) {
    this.piSessionId = ctx.piSessionId;
    this.actor = ctx.actor ?? "system";
    this.harness = ctx.harness ?? "pi";
  }

  /** Open the turn when this message's events include a `user_prompt`. A new
   *  prompt mid-run is handled by LHC's own turn machine (close-then-open); the
   *  accumulator only needs to know a turn is open for the `agent_end` close.
   *  When `msg` carries a timestamp, latch `startedAt` on turn open and always
   *  advance the last-message timestamp for `endedAt`. */
  onMessage(events: MessageEventInput[], msg?: AgentMessage): void {
    const opening = events.find((event) => event.eventKind === "user_prompt");
    if (opening !== undefined) {
      this.open = true;
      this.openTurnKey = opening.idempotencyKey;
      // New LHC turn: reset host-fact latches; startedAt comes from this message.
      this.startedAtMs = null;
      this.lastTimestampMs = null;
      this.lastStopReason = undefined;
      this.lastErrorMessage = undefined;
      this.step = 0;
    }

    if (msg !== undefined && this.open) {
      if (typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
        if (this.startedAtMs === null) {
          this.startedAtMs = msg.timestamp;
        }
        this.lastTimestampMs = msg.timestamp;
      }
      if (isAssistant(msg)) {
        this.lastStopReason = msg.stopReason;
        this.lastErrorMessage = msg.errorMessage;
      }
    }
  }

  /** Returns `[turn_end]` when a turn is open, else `[]`. Closing is the only
   *  transition the accumulator drives, and it happens once per agent run.
   *  Payload carries optional v5 host facts when timestamps / stopReason were
   *  observed; empty payload remains valid. */
  onAgentEnd(facts?: AgentEndFacts): MessageEventInput[] {
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

    const payload = this.buildTurnEndPayload(facts);

    // Clear latches after close so a reattach-no-op path starts clean.
    this.startedAtMs = null;
    this.lastTimestampMs = null;
    this.lastStopReason = undefined;
    this.lastErrorMessage = undefined;

    return [
      {
        eventKind: "turn_end",
        idempotencyKey: key,
        actor: this.actor,
        harness: this.harness,
        payload,
      },
    ];
  }

  hasOpenTurn(): boolean {
    return this.open;
  }

  /** The step index to stamp on step-bearing events of the open turn; null
   *  when no turn is open (the record keeps NULL — never split). */
  currentStep(): number | null {
    return this.open ? this.step : null;
  }

  /** PI's per-step `turn_end`: the provider cycle ended; the next assistant
   *  message belongs to the next step. Never a turn boundary. */
  advanceStep(): void {
    if (this.open) this.step += 1;
  }

  private buildTurnEndPayload(facts?: AgentEndFacts): TurnEndPayload {
    let stopReason = this.lastStopReason;
    let errorMessage = this.lastErrorMessage;
    let endedAtMs = this.lastTimestampMs;

    const messages = facts?.messages;
    if (messages !== undefined && messages.length > 0) {
      const last = messages[messages.length - 1]!;
      if (typeof last.timestamp === "number" && Number.isFinite(last.timestamp)) {
        endedAtMs = last.timestamp;
      }
      // Final state at agent_end governs: read the last message when it is an
      // assistant (PI's agent_end always ends on an assistant message).
      if (isAssistant(last)) {
        stopReason = last.stopReason;
        errorMessage = last.errorMessage;
      }
    }

    const payload: TurnEndPayload = {};
    const outcome = mapStopReason(stopReason, errorMessage);
    if (outcome.outcome !== undefined) payload.outcome = outcome.outcome;
    if (outcome.outcomeReason !== undefined) payload.outcomeReason = outcome.outcomeReason;
    if (this.startedAtMs !== null) payload.startedAt = isoFromEpochMs(this.startedAtMs);
    if (endedAtMs !== null) payload.endedAt = isoFromEpochMs(endedAtMs);
    return payload;
  }
}
