You are the IMPLEMENTOR for Wave 1 fix round 1 of the lhc-rs Phase 1 port.
Both independent verifiers returned FAIL. Fix the reconciled union below.

Work in `/srv/work/long-horizon-context` on branch `lhc-rs-port`.
Resume the existing Cursor session. Do not commit or push. Do not edit outside
`packages/lhc-rs/`. Read the cited TS source before each correction. The
binding brief and Wave 0 ledger rulings still govern; extend, do not reshape.

FAST MODE: this run is launched as `cursor-grok-4.5-high-fast`. If you spawn
any internal Cursor tasks, explicitly use `cursor-grok-4.5-high-fast` for
every one.

## Blockers — fix all

1. `tests/goldens/prompts` is a symlink into `packages/lhc`. The Rust crate is
   standalone. Replace it with real byte-identical files copied into
   `packages/lhc-rs/tests/goldens/prompts/`; never regenerate or rewrite their
   content.

2. `src/shared_tech/prompts/mod.rs`: `PROMPT_REGISTRY` dropped the TS template
   values/render callability (`prompts/index.ts:24-34`). Give each registry
   entry a callable render dispatch/function pointer while the render bodies
   themselves remain `todo!("phase 2")`. Restore the
   `typeof render === "function"` equivalent assertion and make tests resolve
   through the registry rather than a separate `render_by_name` switch.

3. Replace `scripts/check_prompt_bytes.py`'s substring checking with exact
   complete-message reconstruction from the Rust constants and the committed
   oracle inputs. Compare every message role, order, full content bytes, and
   joined bytes for all nine prompts. Validate registry/name wiring. Cover
   every relevant prompt constant, including empty parts, all `NAME`s,
   outcome/tool templates, tool-v2 omit fragments, and all mode guidance.
   Constants not exercised by the single sentinel fixture must have explicit
   byte expectations derived from TS and be checked (do not modify the Wave 0
   oracle fixture). The checker must fail on deletion, insertion, reordering,
   omitted constants, render-recipe/wiring changes, or relevant body/dispatch
   changes. Do not regex-extract TS as the oracle.

4. `tests/inference_prompts.rs`: TS creates 25 runtime tests: nine fixed tests
   plus 8 golden cases and 8 embedding/shape cases from the loop. Generate one
   distinct Rust `#[test]` per prompt per family (25 total), not two internal
   loops. Restore the exact TS detailed-turn-compression-v3 fixture input
   (`⏺ It has 3 open items.`, targets 42/60/78). Preserve every assertion.

5. Fixture type contract: `valid_event` currently takes untyped JSON overrides,
   so the “invalid kind/payload requires explicit cast” test proves nothing.
   Port the TS generic `EventByKind<K>` constraint faithfully using typed
   per-kind inputs/overrides. Add Rust compile-fail coverage (for example
   trybuild UI cases) proving a tool-call payload cannot be passed as a
   user-prompt override. Keep the original runtime assertion under the explicit
   forced conversion equivalent. Do not allowlist a vacuous runtime test.

6. `tests/fixtures_test.rs` malformed config test: preserve all three TS legs.
   Use compile-fail UI coverage for bad mode and incomplete callbacks, and
   `catch_unwind` for the bad chunk policy with an assertion that the panic
   reason names `chunkPolicy`. Do not merely call `init_lhc`; do not create a
   false pass.

7. `tests/validation.rs`: the strict-envelope case must submit the actual extra
   top-level `surprise: true` field from TS `validation.test.ts:160`, not a
   valid `ThreadRef` that it expects to fail. Add a faithful wire-level invalid
   envelope path without weakening the valid closed `ThreadRef`. Also preserve
   the TS regex fragment order for `server-generated.*eventOrder`.

8. `src/shared_tech/derivation.rs`: rename
   `ToolResultConfig.small_tiers_tokens` to `small_tier_tokens` so the wire key
   is exact TS `smallTierTokens` (`derivation.ts:205,231`). Update all uses.

9. Define an exhaustive eight-variant `MessageKind` excluding `turn_end`, with
   byte-exact `as_str()`, and use it for `MessageRecord.kind`
   (`messages/index.ts:43`). Do not alias all of `EventKind` or use `String`.
   Complete `MessageListOptions` with TS `from`, `to`, and `limit`.

10. Remove/correct invented partial surfaces:
    - `threads/mod.rs` `ThreadFileInfo` must be exact `{threadId, createdAt}` or
      be deleted if Wave 1 does not require it.
    - `sdk.rs` `TestingWorkRegistration` must have exact optional `handlers`
      and `dispatchers`, or be deleted if unused.
    - `tests/fixtures/work_handlers.rs` `TestHandlerHooks` must carry the real
      optional async `onHandlerStart`, never `_private`.
    Remove other premature later-wave surfaces not required for Wave 1
    compilation (extra SDK re-exports, ThreadInfo, ChunkRecord/list_chunks,
    target_ratios_of) unless you prove and record why the wave needs them.

11. Persisted JSON order is load-bearing. Replace unordered `HashMap`s in:
    - `view.rs` `StoredViewConfig.percentages` and
      `StoredViewSourceState.derivation_counts`;
    - `derivation.rs` `WorkItemRef.source_ref`.
    Use a closed ordered struct for closed vocabularies and an insertion-order
    map for open records. Audit other Wave 1 serialized/golden report shapes
    (`inspect.rs`, `view.rs`, `inference_types.rs`) and use ordered
    representations where TS `JSON.stringify` order is observable. Do not
    mechanically use alphabetical `BTreeMap` where TS insertion order differs.

12. Transaction ownership/signatures: callbacks and logging must not consume
    the transaction/DB that the outer transaction controller still needs to
    commit or roll back. Make read/write operation callbacks borrow the
    transaction, make `write_log`/`append_derivation_log` accept borrowed
    transactions, and audit `CompletionTx` similarly. One-shot registered
    callbacks should be `FnOnce` where TS semantics are one-shot.

13. Add `skip_serializing_if = "Option::is_none"` to
    `chunk_brief_v1::member_outcomes` and audit every new optional serialized
    field for the same TS omit-vs-null contract.

14. Add exhaustive `as_str()` for every new closed vocabulary missing it,
    including `InferenceRequestRole`. Remove the wildcard arm in
    `fixtures_test.rs`'s four-state derivation match; match the vocabulary
    exhaustively.

15. Restore the dropped damaged-source assertions in `fixtures_test.rs`:
    exact error code `turn_state_corrupt` and queued work kinds exactly
    `["turn_derivation"]`.

16. `logging_surface.rs` TC-5.5a must induce the TS throwing-prepare/failing
    store condition and assert that `write_log` does not panic. Do not discard
    `catch_unwind`. Use the existing storage seam/invalid empty DB if it
    faithfully triggers prepare failure; do not invent a public SDK surface.

17. Restore weakened assertions:
    - `tool_result_rendering.rs`: exact metadata object equality for
      `{outcome:"failed"}`, not field-only.
    - `fixtures_test.rs`: exact full captured-input objects for the per-instance
      callback assertions, not op + one field.
    - prompt registry assertions as covered above.

18. Exact Phase 1 skeleton rule across the entire changed scope:
    behavior source methods/functions must have a body exactly
    `todo!("phase 2")`. Rename unused parameters with `_`; do not put `let _`
    statements, delegating bodies, or partial behavior before the todo. This
    includes `sdk.rs` delegations and later-wave partials. Fixture helper
    behavior is skeletal except the expressly allowed pure data/fs builders.
    Re-audit the inference callback double and model-call helpers against the
    Python ledger notes; do not leave partial behavior hidden before a later
    todo panic. The real SQLite adapter operations needed by `open_raw` are the
    established fixture seam exception; record their exact real surface in the
    ledger.

19. Cleanups that affect fidelity/ledger honesty:
    - deduplicate the duplicate `BoxFuture` alias;
    - make repeated TS `lowerBound: number` fields the same appropriate Rust
      numeric type (use source/tests to select it; record the mapping);
    - restore the `Db::path()` traceability doc to TS `databasePathFor`;
    - update the Wave 0/Wave 1 storage ruling text for the real
      `PreparedStatement::{get,get_params,all,run}` adapter surface;
    - correct prompt/test ticks and notes only after fixes and checks pass.

## Adjudicated verifier override

Fable suggested narrowing Wave 0's `js_json_conformance::*` allowlist. Do not
change it in this round: it is Wave 0 court-of-record scope and not a Wave 1
correctness blocker. Record this verifier override in the ledger, citing
“extend, don't reshape Wave 0”; all new Wave 1 allowlist entries must remain
exact test names.

## Required checks

Run and fix until all are clean:

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
python3 scripts/check_prompt_bytes.py
```

Additionally:
- report TS runtime case counts vs Rust collected counts for every Wave 1
  suite, expanding generated TS loops; inference-prompts must be 25/25;
- perform and report net-zero focused mutations proving the prompt checker
  fails for at least: a byte deletion, insertion, fragment reorder, empty-part
  change, mode-guidance change, omit-fragment change, registry miswire, message
  role/order change, and each of the nine prompt render recipes;
- verify the copied goldens are regular files and byte-identical to TS;
- verify no changes outside `packages/lhc-rs/`.

FINAL REPORT:
- per finding above: fixed/how or disputed with exact TS lines;
- gate and prompt-check output verbatim;
- exact expanded suite counts;
- mutation table and restoration proof;
- all ledger ruling/override notes;
- do not claim Wave 1 done — this is fix round 1 pending re-verification.
