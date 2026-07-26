# Chunk 3A acceptance — after fix round 3 (AA1)

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

Same chunk, one more fix round. Use your own context as you see fit; nothing
here narrows what you may examine.

## Read this first if you passed the chunk last round

**Your last pass was on a superseded tree.** The copy predated fix round 3.

The other lane found — and I confirmed — that `any_capture_active()` is
**process-wide** while `LhcTeePersistence` is **per-session**. So with session A
enabled and session B `/lhc off`, B's persist saw the atomic as true and took
the **global registry mutex**: Chunk 2's L3 defect, narrowed to the multisession
case, which is the normal state of a long-lived shell. Proven by probe —
`registry_lookup_count()` rose on a disabled session.

If you passed last round, note that your own report contains the mechanism:
*"if `any_capture_active()` were true, the tee would fall through to
`lookup_session` and the counter would move."* Your probe asserted
`!capture_active(sid)`, which is **session-local**; the guard is process-wide.
The 7 ns figure was real but only ever exercised the single-session path.

The old timing benchmark was also unsound independently: `saturating_sub` over
two independent sequential samples, five runs giving 0, 0, 0, 0, 7 ns with the
bare loop ranging 1.0–4.2 ms. **It has been removed.**

## What changed

**Per-session generation-cached binding**, keeping the unconditional tee:
`REGISTRY_GENERATION` bumps on every register/unregister; each tee caches
`(generation, Option<CaptureHandle>)`; a persist compares one atomic against the
cache and uses the cached value — including cached `None` — without the registry
mutex; the mutex is taken only when the generation actually moved, which
includes this session's own `/lhc on`.

Evidence is now a **counter assertion**, not a timing:

```
AA1: disabled session B persisted 1000 times while A active;
     registry_lookup_count=0 (want 0)
```

pinned by `aa1_disabled_persist_takes_no_registry_lock_while_other_session_active`.

I verified that test is not vacuous myself: forcing `with_handle` to always
refresh makes it report `registry_lookup_count=1000 (want 0)` and fail. Restored
byte-identical afterwards.

Gates: 150 lib, 85 certification, 5 goldens, both fmt, clippy `--all-targets`
clean, tripwire green at 6/6 hooks.

## What to weigh

The mechanism is new, so it is the thing most worth attacking. Correctness
questions that occur to me, not a limit on yours: whether a cached `None` can
persist across a registration it should have seen; whether generation can wrap
or race such that a stale handle survives; whether teardown ordering can leave a
tee holding a handle to a dead worker; and whether Y1 still holds — mid-session
`/lhc on` must capture from both spawned-off and off-then-on.

**A correction to my own framing.** In the last brief I paraphrased the restated
law as "no I/O, no lock, no allocation, no spawn". One lane correctly noted the
committed artifacts are narrower — FORK.md says no **registry** lock, MAPPING.md
scopes its table to the disabled **persist** path — and that the looser phrasing
would be false, because `clear_last_serve_outcome` in tee `Drop` takes the
`last_serve_map` mutex at teardown. The committed wording is the one to judge.
That teardown mutex is once per session rather than per turn; say whether you
consider it blocking, carryable, or fine.

## Settled — do not redo

Registry lifetime (refuted by both lanes with probes last round; unchanged
since). Z1–Z4, all confirmed by both lanes. Chunk 2 (`817472b`). Live
certification is 3B: anything deferred there with a named checkpoint is not
blocking, and the 3B brief already carries unknown `/lhc` subcommands, `repair
confirm` case-sensitivity, the status early-return asymmetry,
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
**blocking** or **carryable with a named 3B checkpoint**. If you pass, say what
3B's live certification must confirm.
