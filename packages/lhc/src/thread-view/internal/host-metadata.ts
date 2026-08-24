// Host metadata (turn parts, AC-7.1): one read composing the record's open
// turn step facts with the installed view's transition turn. No inference,
// no writes, no walk.
import type { DatabaseSync } from "node:sqlite";
import type { HostMetadata } from "../../shared-tech/index.js";
import { readActiveTurnSteps } from "../../turns/index.js";
import { readInstalledTransition } from "./snapshot.js";

export function readHostMetadata(db: DatabaseSync): HostMetadata {
  const active = readActiveTurnSteps(db);
  const transition = readInstalledTransition(db);
  return {
    activeTurn:
      active === null
        ? null
        : {
            turnId: active.turnId,
            estimatedTokens: active.estimatedTokens,
            completeSteps: active.edges.complete,
            lastStepEdge: active.edges.splittable ? active.edges.lastEdge : null,
            splittable: active.edges.splittable,
          },
    unsettledTurn: transition === null ? null : { turnId: transition.turnId },
  };
}
