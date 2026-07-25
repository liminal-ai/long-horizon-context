# Chunk 2 final gate — round 15 changed scope

You are an **independent adversarial verifier**, read-only with respect to the
project's history. Do not commit. Do not consult or wait for the other verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** Fifteen rounds. The question
is whether anything still blocks acceptance.

## Tree isolation — read this

The two lanes run in **separate trees**, so mutate freely without coordinating.
Note in your report which tree you measured (`ISOLATED-TREE.txt` if present,
otherwise the path) so results are attributable.

Background: for most of this chunk both lanes shared one working tree while
mutation-testing, which made "independent agreement" unverifiable. Fixed. If
you observe files changing under you mid-run, say so — that report is
authoritative and the round gets re-run.

## What round 15 changed

Round 14's framing audit was correct but **entirely unpinned**: a verifier
deleted each of fourteen framing fields one at a time and the full 147-test
suite stayed green on all fourteen. Round 15 pinned them.

**U1 — one `pin_*` test per framing field**, each asserting two items differing
**only** in that field fingerprint differently. Claimed deletion-proved for all
fourteen plus `Assistant.model_fingerprint` and the
OpenPage/Find/FindInPage variants, with rows added to MAPPING.md's Test | Expect
table. Lib tests went 71 → 99.

Attack this:
- **Re-run the deletion sweep yourself**, the way it was originally found:
  remove each field's contribution and confirm the matching test fails. Do not
  trust the reported table.
- For the four **count** fields the report flags with an asterisk
  (`images_count`, `toolcalls_count`, `summary_count`, `content_count`), the
  claim is that deleting only the count integer still leaves item loops
  distinguishing empty from non-empty, so the proof removes the field's *full*
  contribution. Judge whether that makes the pin weaker than the others —
  can you construct two items that differ **only** in a count and still
  collide?
- Are there framing fields with **no** pin at all? Enumerate every field framed
  in `raw_fingerprint` and check each against the test list.

**U2 — every `Option` now frames a presence bit** (`"s"`/`"n"`) before the
value, so `None` ≠ `Some("")` / `Some([])`; `CodeInterpreter.outputs` stays on
`serde_json`. Verify absent-vs-empty for **every** `Option`, including any the
round did not name, and confirm the presence bit cannot itself be spoofed by a
value beginning with `s` or `n`.

**U3 — documentation.** MAPPING.md now claims injectivity over framed
*projections* with the `Option` rule named; FORK.md's carve-out table gained
`rewind_cross_compaction_tests.rs` (`+224/-0`). Verify both against the tree,
and check the carve-out table is now complete — compare it against
`git diff --name-only origin/main -- crates/codegen/ Cargo.toml`.

## Full regression

- Five gate properties: fixpoint, prune-emits-nothing, summary-exactly-once,
  repeated-unchanged-nothing, crash-no-double-record.
- Off-by-default: `GROK_LHC` unset ⇒ behaviourally identical, no added per-turn
  work.
- Chunk 1 invariants: stable `ITEM_KEY_GENERATION`, fresh per-call occurrence
  tracker, monotonic merge.
- Kind conservation round-trips; whole-index failure aborts; per-entry unknown
  synthetic; key reorder silent, array reorder divergent; canonicalization
  instrument-only; informational channel still uses rendered text and has not
  merged with the structural channel.
- Sentinel 6/6; submodule clean at `e582465`; MAPPING.md matches the tree.
- Mutate two tests of your own choosing that no prior round demonstrated.

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
test. Attribute clippy warnings. **If you mutate the tree, restore it exactly
and say so.**

## Settled

Design soundness; write-back; `/btw` and memory flush not hooked; hook 4's
continued existence; identical-content dedup; `truncate_to_prompt_index`
divergence; the SDK typed-view gap; fixtures renderer-faithful rather than
live-captured (**G2 is a mandatory Chunk 3 checkpoint that re-verifies
instrument calibration, not just fixtures**).

## Report

**Lead with: CHUNK 2 — PASS or CHANGES REQUIRED.** Classify every finding as
**genuinely blocking** or **carryable into Chunk 3 with a named checkpoint** —
fifteen rounds in, that distinction is the decision. Then your own deletion
sweep results, the regression check, your two self-chosen mutations, and a
coverage note. If you pass it, list what you would watch for in Chunk 3 live
certification.
