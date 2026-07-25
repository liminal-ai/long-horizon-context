# Chunk 2 acceptance review — the whole chunk, with a ratified condition

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit. Do not consult or wait for the other verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** This is the acceptance
review. If it passes, Chunk 2 is committed and Chunk 3 opens.

## The ratified condition — answer this explicitly

Lee ratified a **design change** mid-chunk: classification moved from parsing
rendered text to typed provenance from `get_session_thread_view`. The
ratification carried a retroactive condition:

> **The dual-verify must confirm the new classifier is SOUND, not merely
> accept it. If either verifier faults the DESIGN — as distinct from the
> implementation — that reopens as a stop.**

So your report must contain an explicit verdict on the **design**, separate
from any implementation findings: **is provenance-based classification sound
for this seam?** Argue it, don't assert it. If you think the design is wrong,
say so plainly — that outcome is expected and wanted, not a failure.

The law it must satisfy, ratified by Lee:

> Never reconstruct structure from rendered text. Classify on typed structure
> only — `source_messages` emptiness, entry variants, `message_id` /
> `idempotency_key` — **never on content byte-equality with native state**,
> because `get_session_thread_view` truncates tool-result content at the view
> boundary.

Check the shipped classifier against that law line by line. Any surviving
content-keyed rule is a finding.

## What the design must handle — attack these

The classifier resolves a `Message(User)` with non-empty `source_messages` to a
real prompt only if **every** source `message_id` resolves to a recorded
`UserPrompt` kind, via a `SourceKindIndex` built from one `messages.list` per
translation. Unknown or missing → **synthetic** (deliberately inverted this
round: wrongly keeping a synthetic costs a marker slot; wrongly promoting one
corrupts the canonical record).

Attack at least:

- **Multi-source entries.** Assistant entries group parts; can a `User` entry
  ever carry sources of mixed kinds, and is "all must be `UserPrompt`" right?
- **Index staleness.** The view and the `messages.list` are fetched in one
  worker round-trip — but can they still disagree (a message recorded between
  them, a pruned or rewound message, a forked thread)? What happens then?
- **Cost and failure on the serving path.** One extra list per turn: what is
  its size on a long session, and what happens under the serve timeout — does
  it fail open correctly, and does a timeout silently degrade classification?
- **The fail-toward-synthetic direction.** Can it be exploited or hit
  systematically — e.g. an empty or partially-built index promoting *every*
  real prompt to synthetic, erasing all markers?
- **Round-trip integrity**, the headline claim: an item entering capture as
  `runtime_note` must still be `runtime_note` after write-back. Verify the test
  binds to that, and hunt for any other kind that can be promoted or demoted
  across a write-back.

## Full-chunk regression check

- **Five gate properties**: fixpoint, prune-emits-nothing,
  summary-exactly-once, repeated-unchanged-nothing, crash-no-double-record —
  now on a fixture containing bands, tool results, a model change **and** a
  runtime note.
- **Off-by-default**: `GROK_LHC` unset ⇒ behaviourally identical, **no added
  per-turn work** (the atomic-first gate, all per-turn paths).
- **Write-back**: native surround matched; `persist_compaction_checkpoint`
  paired; prefix resolution present; token accounting decreases.
- **Equivalence instrumentation**: observe-only; two signals separate;
  fail-open turns not counted as evidence; the band-collapse projection does
  not blind it to a missing or reordered band.
- **Chunk 1 invariants**: stable `ITEM_KEY_GENERATION`, fresh per-call
  occurrence tracker, monotonic merge, capture certification intact.
- **Test sensitivity**: round 9 and 10 demonstrated break-watch-restore for six
  tests. Spot-check at least two yourself — pick the ones you trust least.
  This defect class recurred across three rounds and I do not want it accepted
  on report alone.
- Sentinel 6/6; vendored submodule clean at `e582465`; FORK.md and MAPPING.md
  match the tree; no wildcard `_ =>` over host enums.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

Run the **full** `cargo test`; report lib / certification / goldens separately
and name any ignored test. Attribute clippy warnings to files — warnings inside
the vendored port are a settled false positive. FORK.md numstats are declared
against `origin/main`, not `HEAD`.

## Settled — flagging these is a false positive

Write-back itself; `/btw` and memory flush not hooked; hook 4's continued
existence (removal is by evidence at Chunk 3); identical-content dedup being
correct by design; `truncate_to_prompt_index` diverging from
`state.prompt_index` after write-back (native compaction has the same property,
`rewind.rs:125-136`); ruling R1; `is_error` omitted; that the SDK's public typed
view cannot distinguish a runtime note from a real prompt by variant (recorded
SDK gap — the `message_id` workaround is the sanctioned response); that
write-back fixtures are renderer-faithful rather than captured from a live
compaction (**G2 is a mandatory Chunk 3 checkpoint**).

## Report

**Lead with two verdicts on separate lines:**
1. **DESIGN: SOUND or FAULTED** (with the argument).
2. **CHUNK 2: PASS or CHANGES REQUIRED.**

Then the design analysis, the regression check, your two spot-checked
sensitivity demonstrations with actual output, and a coverage note (reviewed vs
skimmed).
