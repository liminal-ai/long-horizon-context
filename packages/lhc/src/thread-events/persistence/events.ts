import type { NormalizedThreadEventAppendInput } from "../schema.js";
import type { EventRow } from "../sqlite/rows.js";
import { ThreadEventStoreError } from "../errors.js";
import { rowToPersistedEvent } from "./threads.js";
import type { AppendThreadEventsResult, StoreRuntime, PersistedThreadEvent } from "../types.js";

export async function appendEventRecords(
  _runtime: StoreRuntime,
  _clientThreadId: string,
  _events: readonly NormalizedThreadEventAppendInput[],
): Promise<AppendThreadEventsResult> {
  throw new ThreadEventStoreError("appendEventRecords is not implemented yet.");
}

export async function listEventRecords(runtime: StoreRuntime): Promise<PersistedThreadEvent[]> {
  const rows = runtime.db.db.prepare(`
    SELECT *
    FROM event
    ORDER BY thread_id ASC, event_order ASC
  `).all() as unknown as EventRow[];
  return rows.map(rowToPersistedEvent);
}
