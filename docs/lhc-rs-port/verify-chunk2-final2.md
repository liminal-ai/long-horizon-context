# Chunk 2 final confirmation — round 13 changed scope

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit. Do not consult or wait for the other verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** This is the last gate. Chunk 2
has run thirteen rounds; the question now is whether there is **any remaining
reason not to accept it**.

## Context: the last gate split

One verifier passed Chunk 2; the other found three real defects, including a
reproduced `raw_fingerprint` collision. I adjudicated against source and the
second was right. Round 13 fixed all three. Assume nothing here is safe because
someone passed it.

## What round 13 changed

**S1 — fingerprint injectivity.** `raw_fingerprint` now length-frames every
field (`|len:bytes` via `push_framed`) across **all** arms, not just the two
named. Claim: field boundaries are recoverable from lengths, so payload bytes
containing `:` or `;` cannot shift into an adjacent field.

Verify injectivity properly rather than re-running their two pairs:
- Construct your **own** collision attempts — multi-tool-call items, empty
  fields, fields whose content is itself `len:bytes`-shaped, unicode and
  multi-byte content (is `len` bytes or chars? a mismatch is a collision), and
  an empty `tool_calls` vector versus an assistant with text.
- Check the framing is applied to `tool_result` (id, content, image count/parts)
  and every other arm — `system`, `user`, `user_meta`, `assistant`,
  `backend_tool_call`, `reasoning`.
- **Under-reporting is the dangerous direction**: a collision makes a real
  difference read as identical, which is what would wrongly justify removing
  hook 4.

**S2 — key reordering is now silent.** Ruling of record: object key order is
cosmetic and must not fire; array order must remain significant.
`canonicalize_tool_arguments` sorts keys recursively before compact serializing.

Verify:
- Object key reorder silent on **both** channels; array element reorder still
  divergent; nested objects sorted at every depth.
- A **real** change still fires after sorting — value, key add/remove/rename,
  type change, nesting change.
- **The instrument-only claim.** They assert `canonicalize_tool_arguments` and
  `sort_json_keys` have zero call sites outside `equivalence.rs`. I confirmed
  that with a repo-wide grep. Confirm independently that no **persisted**,
  **served**, or **written-back** body can acquire sorted keys — trace it, do
  not just grep. Sorted keys reaching a real body would be a silent mutation of
  user-visible content.

**S3 — the equivalence tests now use the real translator.** The served side
comes from production `decide_substitution` / `session_view_to_serve_items` →
`emit_assistant_conserved` on a `SessionThreadView`; the native side is a
native-shaped body with provider-raw arguments.

Verify the served side genuinely traverses production code — this is the
**fourth** time in this chunk a test claimed to bind to a production path and
did not. Break `emit_assistant_conserved` and confirm the test fails.

## Full regression

- **Five gate properties**: fixpoint, prune-emits-nothing,
  summary-exactly-once, repeated-unchanged-nothing, crash-no-double-record.
- Off-by-default: `GROK_LHC` unset ⇒ behaviourally identical, no added per-turn
  work.
- Chunk 1 invariants: stable `ITEM_KEY_GENERATION`, fresh per-call occurrence
  tracker, monotonic merge.
- Kind conservation still round-trips (tool_call, tool_result, assistant_text,
  assistant_thinking, runtime_note, user_prompt).
- Whole-index failure still aborts; per-entry unknown still synthetic.
- Sentinel 6/6; submodule clean at `e582465`; FORK.md numstats against
  `origin/main`; MAPPING.md matches; no wildcard `_ =>` over host enums.
- **Mutate two tests of your own choosing** that no prior round demonstrated.

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
test. Attribute clippy warnings. Restore the tree exactly and say so.

## Settled

Design soundness (ratified, confirmed by both); write-back; `/btw` and memory
flush not hooked; hook 4's continued existence; identical-content dedup;
`truncate_to_prompt_index` divergence; the SDK typed-view gap; fixtures being
renderer-faithful rather than live-captured (**G2 is a mandatory Chunk 3
checkpoint**, and per the final review it re-verifies instrument *calibration*,
not just fixtures).

## Report

**Lead with: CHUNK 2 — PASS or CHANGES REQUIRED.** If CHANGES REQUIRED, say
whether the item is genuinely blocking or could be carried into Chunk 3 with a
named checkpoint — thirteen rounds in, that distinction matters. Then S1/S2/S3
with your own collision attempts and mutation output, the regression check, and
a coverage note.
