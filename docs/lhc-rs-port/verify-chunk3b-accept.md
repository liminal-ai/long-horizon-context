# Chunk 3B acceptance — G2 on a real compacted body

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22. This closes Phase 3.**

Two things changed since your last pass: Lee ruled on inference lanes, and the
G2 comparison you saw was invalid.

## Lee's ruling, now landed

**Derivations use REAL inference — `grok-4.5` at LOW thinking, via the native
sampler — on both lanes. Not shims.**

The two lanes are `WorkKind::PromptSmoothing → smoothed_prompt` and
`WorkKind::ToolResultSummary → tool_result_summary`; both fan into the single
registered sampler.

I verified at source and by running it: `model_slug()` no longer falls back to
`base_config.model` (it previously used **the session's own chat model** unless
an env var was set), `thinking_level()` returns `ReasoningEffort::Low` and
reaches the built request, and the real-inference test **fails with a
blocked-path message rather than substituting a shim** when credentials are
absent. Live probe output:

```
L3 probe OK [PromptSmoothing]:   model=grok-4.5 label=lhc.smooth_prompt
L3 probe OK [ToolResultSummary]: model=grok-4.5 label=lhc.summarize_tool_result
```

Deterministic callbacks remain, scoped to **mechanism only** — write-back
plumbing, idempotency, crash windows — so that coverage stays credential-free.

## The G2 result you saw was empty, and now is not

Last round's real-inference body came back `bands=0` — **nothing had been
compacted.** With `params: None` the seed was ~6k tokens against a production
budget of 36000 (continuation `lower_bound=120000` × 30%), so write-back wrote
a body that had never been compressed. A 28-item uncompacted conversation
against a 9-item compacted fixture is not a calibration comparison.

Now:

| | |
|---|---|
| Working seed | 6 × 5000 words ≈ **60054 tokens** |
| Budget probe | small 4896 → bands=0; large 60048 → **bands=1** |
| Real G2 | drain **398.5 s** on real `grok-4.5`; **bands=1**; no `[degraded:` |
| Comparison | **10 items / 1 smooth band** vs fixture sketch **9 items / multi-band** — DIFFERS |

The difference is classified as **different input coverage** (the harness seed
has no brief/detailed band, no runtime note, no model change, no tool tail), not
a calibration error, and therefore **not** a regeneration trigger.

`bands > 0` is now asserted before any comparison
(`lhc_real_inference_g2.rs:329`), so a future empty comparison fails loudly
instead of reporting a meaningless difference.

**This classification is the main thing to check.** If any part of the 10-vs-9
gap is genuine calibration error rather than input coverage, that is blocking
and the ruling applies — regenerating fixtures is not the remedy.

Note the G2 test is **not** in the tripwire (it takes ~400 s and needs
credentials); consider whether that is right, and whether anything guarantees it
gets run.

## Also this round

- **M2** — FORK.md no longer says to regenerate fixtures when the live body
  differs; it now requires classifying each difference first and cites the
  ruling. That instruction previously contradicted MAPPING.md and would have
  destroyed the discriminating fixtures on first difference.
- **M3** — `crates/lhc/grok-lhc-host/LIVE_RUNBOOK.md`, L1–L6, each with setup,
  commands, expected, failure criteria, evidence and stop/rollback. **Judge this
  as the deliverable it is** — could Lee execute each item without inferring a
  missing half, and is anything the harness cannot prove missing from it?
- **M4** — the thinking assertion now pins the **built request**
  (`build_derivation_request(…).reasoning_effort == Some(Low)`) rather than the
  accessor, demonstrated by break-watch-restore:
  `left: Some(Medium), right: Some(Low)`.
- Manual-mode `drain_settled` previously only waited; it now runs `work.drain`.

Gates: 154 lib, 86 certification, 5 goldens, 10 harness, both fmt, clippy
`--all-targets` clean, tripwire green, hooks 6/6, vendor `e582465`.

## Settled — do not re-verify

Chunks 1, 2, 3A. Registry snapshot encapsulation. The dedup ruling, write-back,
typed provenance classifier.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

The real-inference G2 run is expensive (~400 s, needs `~/.grok/auth.json`). Run
it if you can; if you do not, say so rather than implying you did.

## Report

**Lead with: CHUNK 3B — PASS or CHANGES REQUIRED.** Give an explicit verdict on
the input-coverage classification and on the runbook as a deliverable. Classify
each finding **blocking** or **carryable onto the live runbook**.

Since this closes Phase 3, also answer plainly: **is this fork safe for Lee to
run on a real session**, what is the first thing he should do, and what is the
most likely way it bites him.
