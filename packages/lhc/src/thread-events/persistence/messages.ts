import type { PersistedThreadEvent } from "../schema.js";
import type { ProjectedMessage, ProjectedMessageBlock, StoreRuntime } from "../types.js";

export interface MaterializedMessageBatch {
  messages: ProjectedMessage[];
  blocks: ProjectedMessageBlock[];
}

export async function materializeMessageRecords(
  _runtime: StoreRuntime,
  _events: readonly PersistedThreadEvent[],
): Promise<MaterializedMessageBatch> {
  return { messages: [], blocks: [] };
}
