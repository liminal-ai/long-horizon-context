# Phase 2 Wave 3 repair-r1 — reconciled full-review findings

Resume Cursor implementor session `0080ea30-39bd-48b7-a3e4-99738b18037e`
with mandatory `cursor-grok-4.5-high-fast`. Work in
`/srv/work/long-horizon-context`, branch `lhc-rs-port`, on the current
uncommitted Wave 3 tree. Read the onboarding, Phase 2 brief, full
`PORT_STATUS.md`, Wave 3 implementation/verification briefs, matching
TypeScript source/tests, and this entire ruling.

Do not commit or push. Preserve the four unrelated root `cc-lhc-*.txt` files.
Own and remove only artifacts you create. Do not broaden the repair into later
waves or general cleanup.

This repair is governed by the phase brief's revised decide-or-stop rule. The
two frozen-test/fixture corrections below are approved forced amendments:
they do not move the 496-test inventory, final `481/0/15` target, wave plan,
scope, or deliverable. Record both in `PORT_STATUS.md`'s Phase-gate addendum
and name both in the eventual Wave 3 commit-body notes.

## Amendment E — remove one unfaithful work-execution assertion

Delete only `assert_eq!(detail.len(), 1)` from
`tests/work_execution.rs` in
`first_touch_catch_up_fails_an_expired_claimed_head_and_drains_the_item_behind_it`.
Keep the `[0]` id/status/expiry assertions unchanged.

Authority and ruling:

- TS checks `liveDetail(...)[0]` and has no length-one assertion; its sibling
  explicitly expects two live items after the same `user_prompt` + `turn_end`.
- Live Node and Rust both produce the claimed prompt-smoothing item followed
  by a turn-derivation item.
- Sol full review `20260724-213354-cd01cd` and Copilot-Fable full review
  `20260724-213354-49f51b` independently ruled this deletion uniquely forced.

After deletion, the test must honestly reach its Wave 7 `init_lhc` boundary,
not be made green early. Expected gate classification is
`145 passed / 336 notimpl / 0 wrong / 15 ignored = 496`, subject to the full
repair behaving faithfully.

## Amendment F — make `TempStore` root allocation atomically unique

Replace `tests/fixtures/mod.rs::temp_store()`'s timestamp-name plus
`create_dir_all` allocation with standard-library atomic exclusive
`create_dir` and collision retry. Prefer PID plus a process-local atomic
sequence for candidate names; retry only `AlreadyExists`, and fail on other
errors. Correctness comes from exclusive `create_dir`, not from assuming the
name is unique. Preserve the existing narrow ownership, `cleanup()`, and
panic-safe `Drop` behavior. Add no dependency and perform no global cleanup.

Authority and ruling:

- TS uses kernel-unique `mkdtempSync`.
- The old helper can choose the same timestamp for concurrent calls, and
  `create_dir_all` then succeeds for both callers, making two stores own one
  directory and producing false gate `WRONG`s.
- Copilot-Fable full review `20260724-213354-49f51b` reproduced a collision.
- Focused Sol concurrence `20260724-220130-2a645c`, resumed session
  `019f960c-9429-7900-91a8-fc17156df66e`, independently ruled atomic
  exclusive creation plus retry the uniquely forced semantic correction.

Add a narrow deterministic fixture test/probe that proves a pre-existing
candidate is never accepted and distinct live stores never share a root.
Do not alter test cases, assertions, inventory, production behavior, or
oracle assets beyond this sanctioned fixture correction and its owning proof.

## Production repairs

1. **Reentrant intake walk hook.** In the walk-hook dispatcher, clone the
   callback `Arc` out of the `RefCell` before invocation so no `RefCell`
   borrow survives across user callback code. Prove a hook can clear or
   replace itself and can perform nested intake without borrow panic. Preserve
   the existing callback point and transaction semantics.

2. **WAL-aware thread validation.** The validation path must faithfully see
   schema/metadata committed in a live WAL, like TS `DatabaseSync` read-only
   open. Do not reuse or weaken Wave 2's immutable scheduler
   `peek_thread_id` opener: it must remain sidecar-free and main-file-only.
   Introduce the narrow private storage/validation strategy needed for this
   distinct contract. Prove valid live-WAL and closed-WAL databases are
   accepted, while foreign/malformed/main-only invalid inputs are rejected.
   For every candidate, verify original main/WAL/SHM/journal bytes, size,
   mtime, mode, and directory entries are unchanged; include read-only
   directory and URI-special-character paths.

3. **Deferred SQLite error mapping and close hygiene.**
   `validate_thread_file` must cover open, schema query, metadata query, and
   close with TS-equivalent catch/finally behavior. SQLite may defer
   `"not a database"` until the first query; map that at any stage to the
   exact caller-error/thread-not-found result. Map other query/open failures
   to the exact storage-failure result, and always close without masking the
   primary classification. Do not let a storage panic escape this public
   validation path.

4. **Exact gate allowlist.** Replace all six Wave 3 suite globs and any ledger
   suite wildcards with every exact newly green test name. The gate must
   recognize only those exact names. Keep the recorded `+62` arithmetic
   honest; derive the names from actual cargo output.

5. **Exhaustive closed enum.** Remove the wildcard arm from the
   `EventKind` match in `src/messages/mod.rs`; spell every closed variant.
   The string/default branch in input validation may remain because it mirrors
   TS validation of unknown input strings.

## Reconciled non-repairs and carry flag

- Do not invent a Node errno-string emulator. Rust and Node each preserve
  their platform-native underlying OS detail; exact error
  class/code/compensation behavior is the contract. Record this adjudication
  in the Wave 3 report.
- Keep the below-SDK thread-local scheduler touch/poke seam for this Wave 3
  scope, but add an explicit Wave 7 carry flag in the ledger: re-audit it
  against real SDK/task-local context and cross-thread runtime behavior when
  `init_lhc` lands. Do not implement Wave 7 now.

## Required evidence and report

Run `cargo fmt --check`, `cargo check --tests`, clippy, all direct Wave 3
suites, every unlocked Wave 2 suite, `runtime_change_typing`, `lifecycle`,
prompt-byte reconstruction, JS-JSON conformance, and the full gate. Mutation
probe each repaired producer/path, including:

- restoring the hook borrow across callback;
- forcing WAL-blind validation;
- deferring malformed-header failure to the schema query;
- making either broad allowlist pattern match an invented test name;
- restoring the `EventKind` wildcard;
- replacing exclusive temp-root creation with accept-existing behavior.

Clean all disposable artifacts. Update the Wave 3 ledger report with exact
files, exact newly green names, `145/336/0/15 = 496` output if obtained,
Amendments E/F and verifier citations, WAL/non-mutation evidence, hook
reentrancy evidence, fixture/assertion/oracle audit, clippy status, carry
flag, cleanup, and no commit/push. Keep Wave 3 **not certified** pending
changed-scope independent confirmation.
