export const LHC_PACKAGE_NAME = "lhc";
export const LHC_PACKAGE_VERSION = "0.0.0";

export interface LhcVersionInfo {
  packageName: typeof LHC_PACKAGE_NAME;
  version: typeof LHC_PACKAGE_VERSION;
}

export function lhcVersionInfo(): LhcVersionInfo {
  return {
    packageName: LHC_PACKAGE_NAME,
    version: LHC_PACKAGE_VERSION,
  };
}

export { runCli, type CliResult } from "./commands/run.js";
export { runThreadEventsCommand, THREAD_EVENTS_HELP_TEXT } from "./commands/thread-events.js";
export { countLocalTokens, localTokenizerMetadataFields } from "./token-counting/local-token-counter.js";
export {
  appendThreadEvent,
  appendThreadEvents,
  createThread,
  listThreadEvents,
  listThreads,
  readThread,
  ThreadEventStore,
  ThreadEventStoreError,
  type AppendThreadEventsResult,
  type CanonicalChunk,
  type CanonicalTurn,
  type ChunkLowerBandCompressionProvider,
  type ChunkPolicy,
  type CreateThreadResult,
  type ProcessTurnEndTriggerResult,
  type ProjectedMessage,
  type ProjectedMessageBlock,
  type ProjectedMessageWithBlocks,
  type ProjectedThread,
  type ProjectedThreadRead,
  type ThreadEventStoreOptions,
  type TurnLowerBandProjectionTokenCounter,
  type TurnProcessingTrigger,
  type TurnSmoothingProvider,
} from "./thread-events/store.js";
export {
  THREAD_EVENT_SCHEMA_VERSION,
  ThreadEventValidationError,
  decodeAppendThreadEventsEnvelopeInput,
  decodeAppendThreadEventsInput,
  decodePersistedThreadEvent,
  decodeThreadCreateInput,
  decodeThreadEventAppendInput,
  type ActorRef,
  type AppendThreadEventKind,
  type AppendThreadEventsEnvelopeInput,
  type AppendThreadEventsInput,
  type HarnessRef,
  type JsonObject,
  type JsonValue,
  type OriginRef,
  type PersistedThreadEvent,
  type ThreadCreateInput,
  type ThreadEventAppendInput,
  type ThreadEventKind,
} from "./thread-events/schema.js";
