# Wave 3 focused Sol ruling — temp-store uniqueness

Resume the Sol Wave 3 verifier read-only in
`/srv/work/long-horizon-context`. Do not edit, commit, push, or mutate shared
source. Fable's independent full audit found a pre-existing frozen-fixture
defect exposed by Wave 3:

- Rust `packages/lhc-rs/tests/fixtures/mod.rs:135-150` implements TS
  `mkdtempSync` using `SystemTime::now().as_nanos()` plus `create_dir_all`.
- TS `packages/lhc/test/fixtures/index.ts:69-70` uses kernel-unique
  `mkdtempSync`.
- Fable observed a full-gate flake: two concurrent fixture calls selected the
  same directory, producing `table thread_metadata already exists` and
  cross-test cleanup; a barrier probe observed same-nanosecond clock values.
  Subsequent gates happened to pass.

Independently inspect and adversarially reproduce or refute. Return an explicit
ruling:

1. Is the current Rust fixture factually unfaithful and capable of producing
   false gate WRONG outcomes?
2. Is replacing it with a kernel-unique creation primitive / atomic
   create-new retry the uniquely forced faithful correction, with no test
   count/assertion/behavior change?
3. Recommend the narrow Rust implementation (prefer an existing dependency or
   standard-library atomic directory creation; no global cleanup and no broad
   new surface).

This is a forced-amendment concurrence check under the rewritten escalation
rule. Include TS citation, probe evidence, exact scope, and whether it changes
the 496/481 arithmetic. Clean only your disposable artifacts.
