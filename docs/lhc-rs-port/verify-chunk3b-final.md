# Chunk 3B final verification — closes Phase 3

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22. This closes Phase 3.**

You have verified this chunk before in this session. Use your own context as you
judge best. Nothing here narrows what you may examine.

**Note on this brief:** it describes only what changed in the code. It
deliberately does not tell you what any other verifier found, or their verdict —
earlier briefs did that, which made agreement corroboration rather than
independence. Reach your own conclusions.

## Tree isolation

Separate trees. State which you measured. Mutate freely; restore and say so, and
report if files change under you.

## What changed since your last pass

Gates: 154 lib, 89 certification, 5 goldens, 10 harness, both fmt, clippy
`--all-targets` clean, tripwire green, hooks 6/6, vendor `e582465`.

### Derivation-lane scope

The inference ruling (`grok-4.5`, low thinking, native sampler, real inference)
is now scoped in MAPPING.md and FORK.md to derivation lanes that call inference
at all — **PromptSmoothing** today. **ToolResultSummary keeps the port's
truncate-fallback** because the port sets
`FORCE_TOOL_RESULT_SUMMARY_FALLBACK = true` (`handlers.rs:35`) and its internal
call site passes `opts: None` (`:537`), so the sampler is unreachable from the
fork. That constant mirrors TS upstream, so the port is faithful, not defective;
reaching the sampler would need a port change and break certified parity.

The counting-sampler test is renamed
`n1_production_replace_drains_prompt_smoothing_tool_result_summary_sampler_absent_by_port`
and asserts SmoothPrompt present **and** SummarizeToolResult absent by design.
**Judge whether that scoping is honest** — including whether any reader could
still take the evidence as "both lanes fired".

### Turn abort now stops derivation

A `CancellationToken` + `DropGuard` enters at `replace_compact_for_writeback`
(hook 5's existing touchpoint — no seventh hook), threaded into
`CaptureCmd::Compact` → `LhcSession::compact` →
`drain_derivations_before_compact`, with `tokio::select!` racing cancel against
the 600 s budget. Inference callbacks use
`install_compact_cancel` / `compact_cancel_for` so in-flight sampler calls see
the same token. On cancel: `compact_cancelled`, no write-back, status records
`CompactDrainOutcome::AbandonedByCancel`.

Claimed evidence: slow sampler, abort at `ops_at_abort=1`, then `ops_after=1`.

**Attack this.** Whether cancellation genuinely reaches an in-flight remote call
rather than only the wait; whether the abort test would pass if the plumbing were
removed; whether anything can be left half-installed on the cancel path; and
whether the `DropGuard` fires on the abort mechanism this host actually uses
(task abort via `tasks_cancel.rs`, not a threaded token).

### Drain budget arithmetic

600 s budget, fail-open on timeout. Observed ~400 s at ≈60k tokens — ~200 s
headroom, recorded as thin. Fail-open is now visible: `tracing::warn` plus
`/lhc status` → `TimedOutFailOpen`. Budget deliberately **not** raised. Judge
whether the arithmetic is stated honestly and whether fail-open on a realistic
session is acceptable or needs to be a hard failure.

### Two items pinned rather than assumed

- `derivation_request_excludes_session_tools_and_agent_prompt` — empty
  tools/hosted_tools, `prompt_cache_key: None`, system prompt < 500 chars.
- Prefix-cache invalidation (~100% on write-back) recorded in LIVE_RUNBOOK as an
  expected cost.

### One latent item I found and did not fix

`LhcSession::compact` passes **`signal: None`** for the port's own
`CompactAbortSignal` (`session.rs:408`). The port defines `compact_stopped()`
(`compact_compute.rs:61`) with a live-read contract — but it has **no callers**,
so the signal is inert today and `None` costs nothing. It is latent: if the port
later wires it in, this fork would silently not benefit. Confirm or refute that
it is inert, and say whether you consider it carryable.

## Settled — do not re-verify

Chunks 1, 2, 3A. Registry snapshot encapsulation. Write-back, dedup, the typed
provenance classifier. The G2 input-coverage classification.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

The credentialed G2 run is `#[ignore]`d, ~400 s, needs `~/.grok/auth.json`. Run
it if you can; if you do not, say so rather than implying you did.

## Report

**Lead with: CHUNK 3B — PASS or CHANGES REQUIRED.** Classify each finding
**blocking** or **carryable onto the live runbook**.

Since this closes Phase 3, answer plainly: **is this fork safe for Lee to run on
a real session**, what should he do first, and what is the most likely way it
bites him.
