# Chunk 2 final acceptance — round 12 changed scope

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit. Do not consult or wait for the other verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** This is the final gate. If it
passes, Chunk 2 is committed and Chunk 3 opens.

## Already confirmed — do not reopen

By both verifiers, with independently reproduced mutations:

- **DESIGN: SOUND** — provenance-based classification (ratified; the question is
  closed).
- **Q1** whole-index failure aborts (serving → Native, write-back → `Err`);
  per-entry unknown stays synthetic; the forced-failure hook is `cfg`-gated and
  production-unreachable.
- **Q2** both fmt gates pass and are inside the tripwire, proven by breaking
  formatting in both crates and watching each gate trip with exit 1.
- **Q3** band negatives bind, proven by re-running the constant-band mutation.
- **Q4** live-tail kind conservation round-trips through real capture; both
  exceptions (`ModelChange`/`ThinkingLevelChange`, `ToolResult.is_error`/
  `tool_name`) are forced by the host sink types; `prompt_index` cannot be
  displaced; orphaned tool calls are stripped downstream by the host.

## What round 12 changed — verify this

The equivalence instrument was miscalibrated in opposite directions, and both
were fixed. This instrument is the **evidence base for Chunk 3's hook-4 removal
ruling**, so its calibration is the point.

**R1 — cosmetic JSON no longer fires.** `canonicalize_tool_arguments`
(`equivalence.rs:126-131`) parses and re-serializes compact, with non-JSON
passing through unchanged; it is applied in **both** the informational
projection and the structural fingerprint.

Verify:
- A **cosmetic** formatting difference is silent on **both** channels.
- A **real** argument change still fires. Check value changes, key
  addition/removal, nesting changes, and type changes (`5000` vs `"5000"`).
- **Key order**: the port enables `serde_json/preserve_order` workspace-wide, so
  a reordered-key payload is preserved rather than sorted. Decide whether
  reordering *should* register, and say which behaviour ships.
- **Non-JSON arguments** (malformed, empty, plain string) pass through without
  panic and still compare sanely.
- The new tests build their two sides by **genuinely different paths** — the old
  ones were blind because both sides came from the same translator. Confirm the
  new ones are not blind the same way.

**R2 — `raw_fingerprint` now includes tool-call identity**, formatted
`assistant_tools:{name}@{id}:{canonical_args};…:{content}` rather than the
constant `assistant_tools:`.

Verify a swapped tool **name**, a swapped **id**, and a changed **argument**
each register structurally, and that the fingerprint cannot be spoofed by
content text containing the delimiters (`@`, `:`, `;`).

**R3** — FORK.md numstats re-verified against `origin/main` (`compaction.rs`
now `+181/-1`). Check the whole table yourself.

## Regression check

- **Five gate properties** on the current fixture: fixpoint,
  prune-emits-nothing, summary-exactly-once, repeated-unchanged-nothing,
  crash-no-double-record.
- Off-by-default: `GROK_LHC` unset ⇒ behaviourally identical, no added per-turn
  work.
- Chunk 1 invariants: stable `ITEM_KEY_GENERATION`, fresh per-call occurrence
  tracker, monotonic merge.
- Sentinel 6/6; vendored submodule clean at `e582465`; MAPPING.md matches the
  tree; no wildcard `_ =>` over host enums.
- **Pick two tests neither round 11 nor round 12 demonstrated and mutate them
  yourself.** Every sensitivity claim in this chunk that was checked this way
  has held; every one taken on report has eventually failed.

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
test. Attribute clippy warnings to files. Restore the tree exactly as found and
say so.

## Other settled items

Write-back itself; `/btw` and memory flush not hooked; hook 4's continued
existence (removal is by evidence at Chunk 3); identical-content dedup correct
by design; `truncate_to_prompt_index` diverging from `state.prompt_index` after
write-back; the SDK gap where the typed view cannot distinguish a runtime note
from a prompt by variant; write-back fixtures being renderer-faithful rather
than captured live (**G2 is a mandatory Chunk 3 checkpoint**).

## Report

**Lead with: CHUNK 2 — PASS or CHANGES REQUIRED.** Then R1/R2/R3 with evidence,
the regression check, your two self-chosen mutation results with actual output,
and a coverage note. If you pass it, say explicitly what you would still watch
for in Chunk 3 live certification.
