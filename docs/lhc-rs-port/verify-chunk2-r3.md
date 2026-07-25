# Chunk 2 confirmation re-verify — round 7 changed scope

You are an **independent adversarial verifier**, read-only. Do not fix, edit,
or commit. Do not consult or wait for the other verifier.

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Two consecutive hard-gate rounds failed, so this confirmation gets the full
dual treatment rather than a single alternating lane. Your job is the **changed
scope of round 7**, plus a regression check that the previously-confirmed
properties still hold.

## What round 7 changed, and what to attack

**L1 — the impossible assertion.** `serving_skips_bands_for_prompt_index`
demanded three markers from a context with two real users. Serving now uses
**tail** assignment (matching write-back) and the test asserts `[1, 2]`.
Judge: is tail assignment actually correct for **serving**, or was the test
simply moved to agree with the implementation? Serving substitutes a body for
one request; write-back rewrites persistent state. Those are different
operations and the justification that fits one may not fit the other. Would the
test fail if bands consumed marker slots, or if head assignment returned?

**L2 — the classification fix (attack this hardest).** The prefix-only
classifier let a real user prompt beginning with `[context · ` be converted to
`user_meta`, collide with an earlier band item, and be **dropped by dedup**.
The fix (`classify_lhc_user_as_synthetic`, `serving.rs:148`): an exact match
against the set of native real-user prompt texts overrides the prefix
heuristic; otherwise the prefix heuristic applies.

Ruling of record, do not re-litigate: identical-content dedup is **correct by
design** (Lee, after reading `idempotency.rs`), and this collision was
adjudicated as an adapter classification defect rather than a dedup-contract
defect, because an item retaining `synthetic_reason: None` cannot collide — the
digest includes the enum representation.

What to test instead: **can you still construct a case where a genuine user
turn is lost, or a synthetic item is mistaken for a real turn in a way that
corrupts `prompt_index` or rewind?** Consider at least: a real prompt that is
byte-identical to a band item *and* absent from native (can that happen?);
multi-part user content where the joined text matches but the parts differ;
a real prompt matching a *tool-result* or *runtime-note* prefix rather than a
band prefix; and the declared residual — a genuine synthetic whose bytes equal
a native prompt, kept as a real user. Is that residual's cost really just one
spurious `prompt_index` slot, or can it desynchronize rewind?

**L3 — off-by-default.** `capture_active` now short-circuits on
`any_capture_active()` (a relaxed atomic) before the registry lookup. Verify
**every** per-turn path that consults capture state, not just `turn.rs:2124` —
the audit was supposed to cover all hooks. Confirm a disabled-path turn touches
no mutex, and that `disabled_path_capture_active_touches_no_registry` would
actually fail if the short-circuit were removed.

**L4 — the permanent false divergence.** Write-back collapses N bands into one
item; serving emits N. The projection now collapses **contiguous** band items
before comparing. Verify this does not blind the instrument: a genuinely
**missing** band, a **reordered** band, or band text differing in content must
still register. Confirm non-band item-count loss is still caught. Structural
divergence should still see N vs 1 — check that it does.

**L5 — projection whitespace.** Now only `\r\n`/`\r` → `\n` plus outer trim.
Confirm indentation and internal whitespace survive, so a code or JSON payload
difference cannot hide.

**L6 — tests that could not fail.** Three were rebound to production paths:
H3's rewind now drains the production `persist_compaction_checkpoint`; the
crash test uses `arm_crash_mid_replace(1)`; H6 calls the real `compact_thread`
before the crash window. For each, state whether it would now **fail** if the
production behaviour it claims to guard were removed. This class of defect has
recurred across three rounds — be unsparing.

**L7 — fixture causality and doc drift.** The fixture's assistant is now a
`bash` tool call; MAPPING.md and FORK.md numstats were corrected. Verify the
numstats against the tree yourself.

## Regression check

- The five gate properties still hold (fixpoint, prune-emits-nothing,
  summary-exactly-once, repeated-unchanged-nothing, crash-no-double-record).
- Chunk 1 capture invariants; stable `ITEM_KEY_GENERATION`; fresh per-call
  occurrence tracker; monotonic merge.
- No wildcard `_ =>` over host enums; vendored submodule clean at `e582465`;
  sentinel 6/6; FORK.md and MAPPING.md match the tree.
- **The gate script itself:** I added a `--lib` arm because the script ran only
  the integration binaries and reported green over a red unit suite for two
  rounds. Confirm the arm works and that no test binary is still unrun.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
git diff --numstat -- crates/codegen/ Cargo.toml
```

Run the **full** `cargo test`, not the script alone, and report lib /
certification / goldens counts separately. Attribute clippy warnings to files —
warnings inside the vendored port are a settled false positive.

## Settled — flagging these is a false positive

Write-back itself; `/btw` and memory flush not hooked; hook 4's continued
existence (removal is by evidence at Chunk 3); identical-content dedup being
correct by design; `truncate_to_prompt_index`'s positional count diverging from
`state.prompt_index` after write-back (native compaction has the same property —
`rewind.rs:125-136` — which is why rewind routes through `replay_to_prompt`);
ruling R1; `is_error` omitted; that the write-back fixtures are renderer-faithful
but not captured from a live compaction (**G2 is a scheduled Chunk 3
checkpoint** that regenerates them from the real body and re-runs the gate).

## Report

**Lead with a one-line verdict: PASS or CHANGES REQUIRED.** Then L1–L7 each
with evidence and a would-it-fail judgment, then the regression check, then a
coverage note (reviewed vs skimmed).
