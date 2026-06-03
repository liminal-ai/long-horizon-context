import type { PersistedThreadEvent } from "../schema.js";
import type { ProjectedMessage, ProjectedMessageBlock, StoreRuntime } from "../types.js";

export interface ProjectEventResult {
  messages: ProjectedMessage[];
  blocks: ProjectedMessageBlock[];
}

export function projectEventsToMessages(_runtime: StoreRuntime, _events: readonly PersistedThreadEvent[]): ProjectEventResult {
  return { messages: [], blocks: [] };
}
