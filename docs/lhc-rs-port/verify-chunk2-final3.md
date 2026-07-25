# Chunk 2 final confirmation — round 14 changed scope

You are an **independent adversarial verifier**, read-only with respect to the
project's real tree. Do not commit. Do not consult or wait for the other
verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** Fourteen rounds. The question
is whether anything still blocks acceptance.

## You are in an isolated tree — this is new

You are running in a private rsync copy of the fork
(`/srv/work/grok-verif-<lane>`, provenance in `ISOLATED-TREE.txt`), **not** the
shared project tree. Mutate freely: nothing you do can affect the other
verifier or the project.

This exists because a verifier discovered that both lanes had been sharing
`/srv/work/grok-build` for the whole chunk, with mutation testing running
concurrently in it — one lane watched a file change under it mid-run and read
the other's test bodies off disk. That is fixed. **Report measurements from
this copy**, and note its `ISOLATED-TREE.txt` provenance line in your report so
results are attributable.

## What round 14 changed

Both lanes independently reproduced collisions in two `raw_fingerprint` arms
that framed `text_content()` — a lossy aggregate — rather than typed fields:
`BackendToolCall` (dropping id, status, sources) and `Reasoning` (dropping id,
status, encrypted content, and part boundaries).

Round 14 claims to have framed typed fields for those arms **and audited every
other arm** for the same flaw, changing `System`, `User`/`user_meta` (now
framing `synthetic_reason`, `cwd_generation`, `prior_turn_interrupt`,
`prompt_index`, and part count + each part) and `Assistant` (adding `model_id`,
`model_fingerprint`, `reasoning_effort`).

**Attack the completeness of that audit, not just the two reported arms.** The
recurring failure in this chunk has been fixing exactly what was demonstrated
and leaving the identical flaw one arm over — this is the third instance.

Specifically:
- Construct collisions of your **own** against every arm, including the ones
  round 14 says it hardened as a precaution. Vary each typed field in isolation
  — including ones easy to forget: `status`, `model_fingerprint`,
  `cwd_generation`, `prior_turn_interrupt`, image parts, `container_id`,
  `call_id`.
- Check **count-before-elements** framing is present wherever a sequence is
  framed (sources, summary parts, content parts, images, tool calls). A missing
  count lets a differing element count be absorbed.
- Confirm the informational projection **still** uses rendered text — that is
  intentional and separate from the structural fingerprint. Verify the two
  channels have not been accidentally merged.
- Verify a **new** `ConversationItem` variant would be caught: is the match
  exhaustive with no wildcard arm that would silently frame nothing?

## Full regression

- Five gate properties: fixpoint, prune-emits-nothing, summary-exactly-once,
  repeated-unchanged-nothing, crash-no-double-record.
- Off-by-default: `GROK_LHC` unset ⇒ behaviourally identical, no added per-turn
  work.
- Chunk 1 invariants: stable `ITEM_KEY_GENERATION`, fresh per-call occurrence
  tracker, monotonic merge.
- Kind conservation round-trips; whole-index failure aborts; per-entry unknown
  synthetic; key reorder silent, array reorder divergent; instrument-only
  canonicalization.
- Sentinel 6/6; submodule clean at `e582465`; FORK.md numstats vs `origin/main`;
  MAPPING.md matches — including its corrected injectivity statement (framing is
  injective **over the fields framed**).
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
test. Attribute clippy warnings to files.

## Settled

Design soundness; write-back; `/btw` and memory flush not hooked; hook 4's
continued existence; identical-content dedup; `truncate_to_prompt_index`
divergence; the SDK typed-view gap; fixtures renderer-faithful rather than
live-captured (**G2 is a mandatory Chunk 3 checkpoint that re-verifies
instrument calibration, not just fixtures**).

## Report

**Lead with: CHUNK 2 — PASS or CHANGES REQUIRED.** For any finding, state
explicitly whether it is **genuinely blocking** or **carryable into Chunk 3
with a named checkpoint**. Then your own collision attempts with actual output,
the regression check, your two self-chosen mutations, and a coverage note. If
you pass it, list what you would watch for in Chunk 3 live certification.
