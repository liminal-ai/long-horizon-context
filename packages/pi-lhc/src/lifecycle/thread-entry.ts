import type { ThreadRef } from "lhc";

export const LHC_THREAD_ENTRY_TYPE = "pi-lhc.thread";

export interface DurableThreadEntry {
  threadId: string;
  registryPath?: string;
}

export function durableThreadEntryOf(ref: ThreadRef): DurableThreadEntry | null {
  if (!("threadId" in ref)) return null;
  const entry: DurableThreadEntry = { threadId: ref.threadId };
  if (ref.registryPath !== undefined) entry.registryPath = ref.registryPath;
  return entry;
}
