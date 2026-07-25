# Chunk 2 acceptance confirmation — round 11 changed scope

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit. Do not consult or wait for the other verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.** If this passes, Chunk 2 is
committed and Chunk 3 opens.

## Closed — do not reopen

Both acceptance verifiers returned **DESIGN: SOUND** on provenance-based
classification, satisfying Lee's ratification condition. One argued it is
*forced*: on the public typed view the only discriminators are entry variant
(identical for prompts and runtime notes), `source_messages` (identical shape),
and the rendered text prefix — so once the prefix is forbidden by the ratified
law, `message_id` provenance is the residual. A mechanical sweep found zero
content-keyed rules in the classifier. **This question is settled.** Flagging it
again is a false positive.

## The four blockers — confirm each is actually fixed

**Q1 — whole-index failure.** `get_classify_context` now returns `Err` on a
`messages.list` failure instead of an empty index, so serving falls open to
Native and write-back aborts. Confirm both granularities: a **per-entry**
unknown still classifies synthetic (unchanged), while a **whole-index** failure
performs no substitution and no write-back. Verify the forced-failure hook is
`cfg`-gated to test builds and cannot fire in production.

**Q2 — formatting.** Both `fmt --check` gates pass, and both are now **inside**
`scripts/check-lhc-hooks.sh`. Confirm the script actually fails when formatting
is broken — the tripwire has twice reported green over a check it did not run.

**Q3 — band negatives.** `band_collapse_missing_band_is_informational` and
`band_collapse_reordered_bands_is_informational` were added after mutation
testing showed the positive tests pass under a projection that replaces every
band with a constant. Confirm the negatives genuinely bind: re-run that
mutation yourself and check the negatives fail.

**Q4 — live-tail kind conservation.** The claimed table:

| Kind | After write-back |
|---|---|
| `user_prompt` | `User` + `prompt_index` |
| `runtime_note` | `user_meta` → recaptured `runtime_note` |
| `tool_call` | `Assistant.tool_calls` → `tool_call` |
| `tool_result` | `ToolResult` → `tool_result` |
| `assistant_text` | `Assistant` |
| `assistant_thinking` | `Reasoning` sibling |
| bands (empty sources) | `user_meta` — compaction prose, by design |
| `ModelChange` / `ThinkingLevelChange` | stay `user_meta` — no host `ConversationItem` variant |
| `ToolResult.is_error` / `tool_name` | omitted — host `ToolResultItem` lacks the fields |

Attack this hardest; it is the newest and it changes the written-back body
shape:

- Verify each conserved kind **actually** round-trips — item entering capture
  as kind K is still kind K after write-back — rather than merely being
  constructed as the right variant.
- Verify the two documented exceptions are genuinely forced by the host type,
  not chosen for convenience. If `ModelChange` or the `ToolResult` fields
  *could* be conserved, that is a finding.
- Body shape changed, so re-check the **five gate properties** on the current
  fixture: fixpoint, prune-emits-nothing, summary-exactly-once,
  repeated-unchanged-nothing, crash-no-double-record.
- Check `prompt_index` assignment is unaffected by the new item kinds, and that
  reconstructed tool calls cannot collide with or displace live-turn markers.
- Does restoring structured tool calls change the equivalence comparison
  (structural or informational) in a way the instrument now mis-reports?

## Regression check

- Off-by-default: `GROK_LHC` unset ⇒ behaviourally identical, no added
  per-turn work.
- Chunk 1 invariants: stable `ITEM_KEY_GENERATION`, fresh per-call occurrence
  tracker, monotonic merge.
- Sentinel 6/6; vendored submodule clean at `e582465`; FORK.md and MAPPING.md
  match the tree (numstats declared against `origin/main`, not `HEAD`); no
  wildcard `_ =>` over host enums.
- **Spot-check two test sensitivities of your own choosing** by mutation —
  prefer ones round 11 did *not* demonstrate. Six-plus tests now carry
  break-watch-restore evidence produced by the agent that wrote them.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

Full `cargo test`; report lib / certification / goldens separately and name any
ignored test. Attribute clippy warnings to files — vendored-port warnings are a
settled false positive.

## Other settled items

Write-back itself; `/btw` and memory flush not hooked; hook 4's continued
existence (removal is by evidence at Chunk 3); identical-content dedup correct
by design; `truncate_to_prompt_index` diverging from `state.prompt_index` after
write-back (native has the same property, `rewind.rs:125-136`); the SDK gap
where the typed view cannot distinguish a runtime note from a prompt by variant
(the `message_id` workaround is sanctioned); write-back fixtures being
renderer-faithful rather than captured live (**G2 is a mandatory Chunk 3
checkpoint**).

## Report

**Lead with: CHUNK 2 — PASS or CHANGES REQUIRED.** Then Q1–Q4 each with
evidence, the regression check, your two self-chosen mutation results with
actual output, and a coverage note.
