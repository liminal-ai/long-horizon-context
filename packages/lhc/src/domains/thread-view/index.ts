// thread-view surface (Epic 03). Story 0 lands the substrate only: profile
// config resolution (consumed by createSdk at construction) and the storage
// migration (owned by shared/storage.ts). The five operations — pull, status,
// compact, sweep, materialize — arrive in Stories 1–5; nothing here is
// reachable from the SDK operation surface yet.
export {
  BUILT_IN_PROFILES,
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_VISIBILITY,
  resolveViewConfig,
} from "./internal/profiles.js";
