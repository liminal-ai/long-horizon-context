# Effect usage in LHC

LHC may use Effect where it improves modeling of validation, structured errors, async provider work, retries, cancellation, resource ownership, and worker orchestration.

For the current migration slice, `effect/Schema` is the runtime validation layer for thread-event inputs and persisted records. This keeps event intake validation explicit and close to the proven reference behavior while the core store is rebuilt.

Public SDK and CLI APIs should remain conventional TypeScript/Promise surfaces unless we explicitly decide otherwise.

SQLite persistence and deterministic domain transformations should stay simple where plain TypeScript and SQL are clearer. Effect can still be used around those areas if a concrete module has resource, retry, concurrency, or structured-error complexity that it helps clarify.

Dependency choices should be made case by case based on clarity, portability, testability, runtime behavior, and operational needs.
