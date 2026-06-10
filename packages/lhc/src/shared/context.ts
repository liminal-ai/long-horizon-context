import type { DatabaseSync } from "node:sqlite";

export interface OperationContext {
  db: DatabaseSync; // open thread-file handle, inside the batch transaction
  clock: () => Date; // injected for deterministic recordedAt/queuedAt in tests
  threadId: string; // resolved identity of the thread being operated on
}
