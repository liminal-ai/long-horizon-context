# Phase 2 Wave 6 repair round 5 — all integer readers reject `2^63`

Resume the established Cursor implementation session with mandatory
`cursor-grok-4.5-high-fast`. Work in `/srv/work/long-horizon-context`, branch
`lhc-rs-port`, from the uncommitted Wave 6 tree based on certified Wave 5
`81553fc`. Do not commit or push. Preserve the four root `cc-lhc-*.txt` files
and clean only your artifacts.

Read Amendment I, repair-r1–r4 records, the final confirmation prompt, and
this verifier reconciliation. Keep all r4 producer/oracle/budget fixes.
Repair the two missed integer readers without moving the 496 denominator,
test names/ignores, public surface, wave plan, or production semantics.

## Confirmation reconciliation

- Sol confirmation `20260725-040456-03703f` independently found the two
  defects below, then its run ended with a harness cleanup-command rejection;
  treat its substantive source finding as FAIL evidence, not a complete
  report.
- Copilot-Fable `20260725-040456-301c90`, session
  `4bba60a8-5137-4452-bfd6-a531af0b322e`, verified
  `claude-fable-5` medium and returned PASS, but its item-7 claim that all
  integer readers reject `2^63` is contradicted by the live source. Override
  that narrow claim; retain its uncontradicted producer/mutation evidence.
- The orchestrator independently located the same exact patterns:

  ```text
  src/thread_view/internal/boundary.rs:34-37
  src/thread_view/mod.rs:534-537
  ```

Both still accept an integral finite `f64` when
`f <= i64::MAX as f64`, then cast with `f as i64`. On this target
`i64::MAX as f64 == 2^63`, so `9223372036854775808.0` passes and saturates to
`i64::MAX`. Snapshot and select were fixed; the union of Wave 6 readers was
not.

## Required repair

1. Make one private/shared `f64 → exact i64` conversion for the Wave 6
   thread-view readers, or otherwise ensure all four reader families use the
   same exclusive-upper-bound rule:
   - snapshot;
   - select;
   - boundary;
   - prune/zone readers in `thread_view/mod.rs`.

   Do not expose a public/test-only helper. Preserve each caller's exact
   corruption diagnostic where it differs.
2. Required semantics:
   - accept `Value::Number::as_i64()` first, including exact JSON
     `i64::MIN`/`i64::MAX`;
   - accept finite, integral, in-range SQLite reals whose round-trip is exact;
   - accept `i64::MIN` as real;
   - reject `f >= 2^63`, below `i64::MIN`, fractions, non-finite values, and
     imprecise/saturating casts;
   - retain existing string-integer behavior.
3. Add no test. Use an already-sanctioned counted consumer only if committed
   evidence is needed; otherwise use disposable isolated probes. Directly
   exercise and mutation-prove each missed runtime path:
   - `boundary::read_boundary_position` with a REAL `2^63` position;
   - `boundary::visibility_zone_tokens` with a REAL `2^63` aggregate/value;
   - public prune/zone reading with a REAL `2^63` `token_estimate` (or the
     narrowest exact production entry that reaches `mod.rs::map_required_i64`);
   - baseline exact integers/in-range integral reals still succeed.

   Reverting either missed reader to
   `f <= i64::MAX as f64; f as i64` must turn its probe red.
4. Sweep the full Wave 6 source after repair:

   ```text
   rg 'f <= i64::MAX as f64|f >= i64::MIN as f64' src/thread_view
   ```

   Only explanatory comments may remain; no executable rounded-bound pattern.
5. Correct `PORT_STATUS.md` and append `phase2-fix5-wave6-report.md`:
   name the Sol finding, Fable narrow override, both repaired paths, direct
   probes/mutations, and unchanged gate arithmetic. Do not erase the
   historical verifier disagreement.

Run fmt/check/clippy, affected focused probes/suites, the 26-row Amendment I
consumer and double regeneration, exact owning checks, and the full gate.
Report cleanup and no commit/push. Wave 6 remains not certified pending
changed-scope confirmation.

Sol's failed verifier left its own exact scratch
`/tmp/lhc-w6-confirm-r4-t1J6AaXE` (about 4.1 GB). Do **not** delete another
agent's artifact; the resumed Sol verifier owns that cleanup. The
implementation agent cleans only r5 scratch it creates.
