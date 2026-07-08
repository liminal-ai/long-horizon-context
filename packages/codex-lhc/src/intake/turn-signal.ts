import type { RolloutLineItem } from "../rollout/types.js";

export type TurnSignal = "opens" | "closes" | "neutral";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function payload(item: RolloutLineItem): Record<string, unknown> | undefined {
  return isRecord(item.payload) ? item.payload : undefined;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function turnIdForSignal(item: RolloutLineItem): string | undefined {
  const linePayload = payload(item);
  if (linePayload === undefined) return undefined;
  return stringField(linePayload, "turn_id");
}

export function classifyTurnSignal(item: RolloutLineItem): TurnSignal {
  const linePayload = payload(item);
  if (linePayload === undefined) return "neutral";

  if (item.type === "event_msg") {
    const eventType = stringField(linePayload, "type");
    if (eventType === "task_complete" || eventType === "turn_aborted") return "closes";
    if (eventType === "task_started") return "opens";
    return "neutral";
  }

  if (item.type === "turn_context" && turnIdForSignal(item) !== undefined) {
    return "opens";
  }

  return "neutral";
}

export interface CodexTurnSignalClassifier {
  classify(item: RolloutLineItem): TurnSignal;
  currentTurnId(): string | undefined;
}

export function createCodexTurnSignalClassifier(): CodexTurnSignalClassifier {
  let activeTurnId: string | undefined;

  return {
    classify(item: RolloutLineItem): TurnSignal {
      const linePayload = payload(item);
      if (linePayload === undefined) return "neutral";

      if (item.type === "event_msg") {
        const eventType = stringField(linePayload, "type");
        if (eventType === "task_complete" || eventType === "turn_aborted") {
          const closingTurnId = stringField(linePayload, "turn_id");
          if (closingTurnId !== undefined && closingTurnId === activeTurnId) activeTurnId = undefined;
          return "closes";
        }
        if (eventType === "task_started") {
          activeTurnId = stringField(linePayload, "turn_id") ?? activeTurnId;
          return "opens";
        }
        return "neutral";
      }

      if (item.type !== "turn_context") return "neutral";
      const turnId = stringField(linePayload, "turn_id");
      if (turnId === undefined || turnId === activeTurnId) return "neutral";
      activeTurnId = turnId;
      return "opens";
    },
    currentTurnId(): string | undefined {
      return activeTurnId;
    },
  };
}
