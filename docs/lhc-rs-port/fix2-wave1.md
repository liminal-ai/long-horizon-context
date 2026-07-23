Wave 1 fix round 2, targeted residue only. Work under `packages/lhc-rs/`;
do not commit or push. Launch/resume with `cursor-grok-4.5-high-fast`; any
internal Cursor task must also explicitly use that fast model.

Fix all seven reconciled residues:

1. `persist.rs` async borrowed callback lifetime is still unusable. TS
   `persist.ts:136-155,175-178` permits a callback to borrow the transaction
   across `.await`. Replace the separate unconstrained `Fut` with a
   lifetime-coupled boxed future, e.g.:
   `for<'a> FnOnce(&'a DbReadTransaction) -> Pin<Box<dyn Future<Output=T> + 'a>>`
   and the write equivalent (include Send bounds only if actually required).
   Add compile-pass coverage that passes an async callback, reads the borrowed
   transaction, awaits, then reads it again. The body remains exact Phase 1
   `todo!("phase 2")`.

2. Delete unused Wave-1-premature `DurableWorkDispatcherMap`,
   `TestingWorkRegistration`, and `register_testing_work` from `sdk.rs`.
   They have no Wave 1 consumer; the exact operation-keyed callable map lands
   in the durable-work wave. Update the ledger partial note honestly.

3. `fixtures_test.rs` FC-0.3 metadata: assert the complete serialized metadata
   object is exactly `{"outcome":"succeeded"}`, with no extra fields, matching
   `fixtures.test.ts:374-379`.

4. `fixtures_test.rs` FC-0.2 failure: compare the complete
   `InferenceResult::Err`, requiring `reason == "content refusal"` and
   `request_messages == None`, matching `fixtures.test.ts:199-204`.

5. `logging_surface.rs`: selected `reason`, `gaps`, and `metadata` columns must
   exist and equal JSON null. Replace missing-or-null assertions with exact
   `row.get(key) == Some(&Value::Null)` per `logging-surface.test.ts:152-168`.

6. Remove the redundant `#[serde(rename = "from")]` on
   `MessageListOptions.from`; retain `skip_serializing_if`.

7. Remove crate-root/sdk re-exports with no `sdk.ts` counterpart: `Db`,
   `LeaseConfig`, `NewThreadResult`, `MessageKind`, plus `SdkMode` and
   `NewThreadInput`. Update the two Wave 1 tests to import `SdkMode` and
   `NewThreadInput` from their canonical internal modules for compile/shape
   coverage. Do not retain invented root surface merely for test convenience.
   Record this correction in the ledger.

Run:

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
python3 scripts/check_prompt_bytes.py
```

Gate must retain exact reconciliation, wrong=0, suspicious=0. Report the
async-borrow compile proof and each residue's correction. Do not claim Wave 1
done; confirmation remains.
