# SQLite schema posture

LHC v0 uses a clean local SQLite schema owned by the `lhc` core package.

The thread-event store uses singular table names such as `thread` and `event` and records schema state through SQLite metadata such as `PRAGMA user_version`.

The new LHC core does not attempt to share one SQLite database with legacy `.context-steward` MVP tables or older plural-table schemas. If compatibility or migration from those stores is needed later, it should be implemented as an explicit import/migration path rather than implicit schema coexistence in the hot path.

Readers and writers should reject or migrate incompatible future schema versions explicitly before mutation.
