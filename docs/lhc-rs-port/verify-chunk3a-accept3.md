# Chunk 3A acceptance — after fix round 5

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

Same chunk, two more fix rounds since your last pass. Use your own context as
you judge best; nothing here narrows what you may examine.

## What happened since you last looked

**You both found the same race, independently, in separate trees** —
`refresh_binding` reading the generation *after* the lookup, so a registration
landing between them stamped a stale `None` with the new generation and pinned
it forever. One lane proved it with forced delay instrumentation; the other
proved it with a 400 ms window and showed the code inverted its own documented
contract at `capture.rs:32`. That was the first genuinely independent
convergence of the project.

**Round 4 fixed it** with `lookup_session_snapshot` returning
`(generation, handle)` under the registry mutex. I verified the atomicity at
source rather than from the report: both generation bumps happen while holding
the registry lock (`capture.rs:470`, `capture.rs:486`) and the snapshot reads
the generation while still holding it (`capture.rs:512`).

**Then I broke the test myself, and it did not fail.** I reverted
`refresh_binding` to the exact two-observation assembly and **all 151 tests
passed**. The test toggled a racy branch *inside the helper*, so it compared
"atomic helper vs racy helper" and never varied how the call site assembled its
pair.

**Round 5 closed that.** Two things now hold:

1. **The defect is unwritable.** `RegistrySnapshot` has private fields and is
   only stamped inside `lookup_session_snapshot` under the mutex. I tried to
   construct one from a bare `registry_generation()` plus a separate
   `lookup_session()` and it fails to compile: `E0451: fields generation and
   handle of struct RegistrySnapshot are private`.
2. **The runtime test now pins the call site**, toggling racy assembly at
   `refresh_binding` rather than in the helper.

Break-watch-restore was run on four tests with verbatim failure output — AB1,
AA1, and both Y1 probes. I independently reproduced the AB1 compile failure and
the AA1 counter failure myself; the Y1 probe demonstrations I have not
reproduced.

Gates: 151 lib, 85 certification, 5 goldens, both fmt, clippy `--all-targets`
clean, tripwire green at 6/6 hooks.

## What to weigh

The cache type and the racy test hook are new, so they are the most interesting
surface. Questions that occur to me, not a limit on yours: whether
`from_parts_for_test` can leak into a production path; whether the test-only
hooks change production behaviour when `test-util` is off; whether the
`RegistrySnapshot` encapsulation actually closes every route to a mismatched
pair, or only the one I tried; and whether Y1, AA1 and the unregister-during-
refresh case still hold.

I would rather you attacked the encapsulation claim than re-confirmed the
things two lanes have already confirmed twice.

## Settled — do not redo

Registry lifetime (refuted with probes). Z1–Z4. The teardown mutex (judged
fine). Generation wrap. Chunk 2 (`817472b`). Live certification is 3B, and
anything deferred there with a named checkpoint is **not** blocking — the 3B
brief already carries unknown `/lhc` subcommands, `repair confirm`
case-sensitivity, the status early-return asymmetry,
`refresh_settings_and_reapply`'s `set_var`, G2, and Replace recoverability.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

Confirm hooks 6/6, no seventh touchpoint, vendored port clean at `e582465`,
Chunk 1/2 invariants intact.

## Report

**Lead with: CHUNK 3A — PASS or CHANGES REQUIRED.** Classify each finding
**blocking** (the product is wrong) or **carryable with a named 3B
checkpoint**. If you pass, say what 3B's live certification must confirm.
