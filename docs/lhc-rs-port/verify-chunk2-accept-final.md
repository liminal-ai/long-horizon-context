# Chunk 2 acceptance — round 16 changed scope

You are an **independent adversarial verifier**, read-only with respect to
project history. Do not commit. Do not consult or wait for the other verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** Sixteen rounds. Both
acceptance verifiers already agreed the **engineering is sound** and that the
sole blocking item was a **documentation claim** asserting coverage that did not
exist. Round 16 closed that. This gate decides acceptance.

## Tree isolation

The two lanes run in **separate trees** — one in `/srv/work/grok-build`, one in
an rsync copy. Mutate freely. **State which tree you measured.** If files change
under you mid-run, say so; that report is authoritative and the round re-runs.

## What round 16 changed

A prior sweep deleted each of **63** framed contributions in `raw_fingerprint`
and found **41 survived** the full suite. Round 16 claims every contribution is
now **either** pinned by a test that fails on its deletion, **or** documented as
structurally redundant with an argument — no third category — and published the
full 63-row accounting in MAPPING.md. Lib tests 99 → 131.

Also claimed:

- **W2** — two tests that claimed coverage they did not provide are
  de-confounded: `raw_fingerprint_reasoning_summary_parts_do_not_collide` varied
  *both* `id` and summary shape; `pin_websearch_find_vs_find_in_page` compared
  two *variants*. Each should now vary exactly one thing.
- **W3** — the six derived counts (`images_count`, `toolcalls_count`,
  `summary_count`, `content_count`, `User.content_count`, `WS.sources_count`)
  are **documented-redundant, deliberately not tested**: they are derived from
  the vector they precede, so no constructible pair differs only in a count, and
  deleting one leaves the encoding injective because `push_framed` is
  length-prefixed with fixed arity around each loop.
- **W4** — `push_option_dbg`'s presence bit is **inert** (non-empty `Debug`
  means `None` and `Some(v)` differ on the value field regardless), so
  absent-vs-present tests were deliberately **not** added for
  `User.cwd_generation`, `prior_turn_interrupt`, `prompt_index`. Documented as
  an asymmetry against `push_option_str`, whose bit **is** load-bearing.

## Verify

1. **Re-run the deletion sweep yourself.** Delete each framed contribution
   individually and confirm a test fails. **Report the count that survives.**
   The prior sweep found 41 survivors against a claimed-complete inventory —
   the number is the deliverable, not the assurance.
2. **Check the 63-row accounting against the code**, not against itself. Does
   the row count match the actual number of framed contributions? Is any
   contribution missing from the table entirely? If the table and code disagree,
   the code wins.
3. **Audit the redundancy exemptions adversarially.** W3's argument depends on
   `push_framed` length-prefixing plus fixed arity per arm, and on `Reasoning`'s
   summary terminating on the literal `"summary_text"` which can never equal the
   `"n"`/`"s"` presence bit. **Try to break that**: construct two items whose
   fingerprints collide with a count deleted. If you succeed, the exemption is
   wrong and those counts must be pinned or removed.
4. **Check W4's inertness claim** — force `push_option_dbg`'s `None` arm to emit
   `"s"` and confirm the suite still passes (i.e. the bit really is inert
   there), and that the same mutation on `push_option_str` **does** fail tests.
5. **W2** — confirm each de-confounded test varies exactly one thing, and that
   the fields they were meant to cover (`Reasoning.id`, the summary loop,
   `Find.url`) are now individually caught.

## Full regression

Five gate properties; off-by-default; Chunk 1 invariants (stable
`ITEM_KEY_GENERATION`, fresh per-call occurrence tracker, monotonic merge); kind
conservation; whole-index failure aborts; per-entry unknown synthetic; key
reorder silent / array reorder divergent; canonicalization instrument-only;
informational channel still rendered-text and not merged with structural.
Sentinel 6/6; submodule clean at `e582465`; FORK.md numstats vs `origin/main`;
MAPPING.md matches the tree. Mutate two tests of your own choosing that no prior
round demonstrated.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

Full `cargo test`; lib / certification / goldens separately; name any ignored
test. Attribute clippy warnings — vendored-port warnings are settled. **Restore
the tree exactly and say so.**

## Settled

Design soundness; write-back; `/btw` and memory flush not hooked; hook 4's
continued existence (removal is by evidence at Chunk 3); identical-content
dedup; `truncate_to_prompt_index` divergence; the SDK typed-view gap; fixtures
renderer-faithful rather than live-captured (**G2 is a mandatory Chunk 3
checkpoint that re-verifies instrument calibration, not just fixtures**); that
`raw_fingerprint` is observe-only and cannot corrupt served output or write-back
(its result is discarded at `turn.rs:2145`).

## Report

**Lead with: CHUNK 2 — PASS or CHANGES REQUIRED.** Classify each finding as
**genuinely blocking** or **carryable into Chunk 3 with a named checkpoint**.
Sixteen rounds in, that classification is the decision — say plainly whether
anything left is worth another round. Then your sweep survivor count, the
accounting audit, your attempt to break the redundancy exemptions, the
regression check, and your two self-chosen mutations. If you pass it, list what
you would watch for in Chunk 3 live certification.
