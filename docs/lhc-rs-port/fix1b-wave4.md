# Wave 4 repair round 1b — remove out-of-scope context behavior

You are the Wave 4 IMPLEMENTOR residue pass. Work in the existing uncommitted
Wave 4 worktree. Do not commit/push. FAST MODE is explicitly
`cursor-grok-4.5-high-fast`.

The r1 repair improperly made three pre-existing shared-tech context behaviors
REAL solely to support a Wave 4 test-fixture proof:

- `set_scheduler_poke`
- `set_thread_touch`
- `resolve_instance_poke`

This violates the Phase 1 exact-body rule and changes a previously certified
Wave 1 file outside Wave 4. Restore all three function bodies in
`src/shared_tech/context.rs` to exact `todo!("phase 2")` and restore the file's
prior Phase 1 documentation/import state. The final Wave 4 diff must contain no
change to `src/shared_tech/context.rs`.

Adapt the RAII hook guards in both `tests/mutations.rs` and
`tests/mutations_delete.rs`:

- acquisition only takes the per-binary mutex; it must not call the deferred
  setters;
- Drop invokes each setter inside its own `catch_unwind(AssertUnwindSafe(...))`
  so a Phase 1 todo panic during an existing unwind cannot double-panic/abort;
- in Phase 2, once the setters are implemented, the same Drop path performs
  the required resets;
- keep every TS behavior test count exactly 8 and 5 respectively.

Remove the committed Rust-only
`mutations::hook_guard_resets_scheduler_poke_on_panic_unwind` test and its
allowlist entry. Do not replace it with an extra test inside either TS-mapped
suite. Instead, mutation-prove the RAII dispatch in an isolated copy by
temporarily injecting an observable reset callback/test seam there only; show
that removing the Drop invocation turns that isolated proof red. Report the
narrow claim honestly: Phase 1 proves panic-safe RAII dispatch; actual context
setter effects remain Phase 2 behavior.

Also tighten
`message_derive_result_failed_wire_shape_round_trips` to compare the entire
serialized object with the exact TS shape, like the other two arm tests, rather
than field-by-field checks that could miss an extra key.

Expected exact-todo reconciliation after restoration: the current 285 gains
three restored context todos, for 288 tokens=bodies=covered. Expected passing
count drops by one after removing the extra mutation-suite proof (other
allowlisted shape/map/serde tests remain).

You own cleanup of the exact isolated artifacts this pass creates. Use Python
`-B`; preserve the four root `cc-lhc-*.txt` files and historic
`/tmp/lhc-test-*`. Run fmt, cargo check --tests, gate, prompt checker, and
suite counts. Report exact cleanup paths and no commit/push.
