# LHC context-health triage notes

This worklog records how durable agent context was inspected and repaired in practice. It is an operator record, not a new source of SDK semantics.

## Evidence order

1. Identify the exact agent, host profile, thread file, and serving process.
2. Read the thread SQLite file directly in read-only mode.
3. Run `PRAGMA integrity_check` and record `PRAGMA user_version`.
4. Read canonical rows, current `thread_view`, band rows, derivation rows, work rows, and logs separately.
5. Use public SDK reads to confirm the same domain state.
6. Treat lhc-console API and UI values as secondary until their query, unit, boundary, and source class match the records.
7. Before an authorized mutation, copy the SQLite file and its WAL/SHM sidecars while the owning process is coordinated or use the host's certified backup path.
8. Repair through a public domain operation. Do not insert derivation or work rows with raw SQL.
9. Record the operation, returned result, source version, resulting derivation/work state, view effect, and integrity result.

## Terms that must remain separate

- **Canonical archive:** stored events, messages, and turns. Existence does not mean the model currently receives the content.
- **Current serving view:** the materialized bands plus post-compact live tail used to build a request. Its `source_state_json` is a snapshot from view creation, not a live derivation-health query.
- **Structural accounting:** a source subject appears in arrangement metadata. A `gap` entry counts structurally but has an empty body.
- **Semantic coverage:** non-empty source information is present through a ready derivation, deterministic fallback, direct turn material, or live tail.
- **Degraded fallback:** non-empty lower-quality material such as `stored_member_concat`. This is not data loss.
- **Empty gap:** arrangement metadata exists but rendered content is empty. This is not semantic coverage.
- **Missing expected boundary:** the domain expects a derivation for a valid subject, but no derivation row exists. It is not `pending`, `failed`, or `blocked`.
- **Current failure:** a stored derivation row is presently `failed` or `blocked`.
- **Historical failure log:** an append-only record of a past attempt. It is not evidence that the current derivation remains broken.
- **Active work:** only queued or claimed work items. Completed historical work rows are not backlog.

## Repair posture

- `ready`: rederive only for a stated quality or staleness reason.
- `failed`: retry through the public domain derive operation when the source remains valid.
- `blocked`: inspect source damage; do not reset automatically.
- `missing expected`: use a public bootstrap operation if the SDK provides one. Otherwise stop and extend the shared SDK contract first.
- `gap`: determine whether the source is unique, redundant replay contamination, or genuinely omitted before choosing a repair.

Repairs optimize coherent, useful memory. Provenance and receipts support that goal; they are not reasons to leave a recoverable agent degraded.
