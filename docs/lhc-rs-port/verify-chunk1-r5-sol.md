# Chunk 1 round-5 confirmation — changed scope only

**Chunk 1 of 3, Phase 3 of 3 — unit ~16 of 18.** Final confirmation before
the orchestrator commits. Read-only: do not fix, edit, or commit.

Your own round-4 report and Opus's both concluded **no live product defect
remained** — the implementation was accepted; only coverage and hygiene were
outstanding. This round addressed exactly those. **Scope is the delta since
then**, not a re-audit of the whole chunk.

## Material

- Repo `/srv/work/grok-build`, branch `lhc`, work **uncommitted**
  (`git diff HEAD` + untracked under `crates/lhc/grok-lhc-host/`).
- The round-5 brief:
  `/srv/work/long-horizon-context/docs/lhc-rs-port/fix5-chunk1.md` (D1–D5).
- Prior briefs for context: `fix3-chunk1.md` (B1–B6), `fix4-chunk1.md` (C1–C2).
- Vendored `crates/lhc/vendor/long-horizon-context` is read-only; any
  modification is critical.

## Confirm each of D1–D5

1. **D1** — `capture_model_or_thinking_change` (hook 3's production entry) now
   has direct coverage, including a session-id mismatch case, the disabled
   fast path, and `None` effort normalization, with at least one under
   `#[tokio::test]`. Would the mismatch test **fail** if hook 3's id stopped
   matching hook 2's?
2. **D2** — the crash test now reopens with an **empty bootstrap** and asserts
   **0 events** before the repopulating respawn. Is it finally
   discriminating — i.e. would it fail if the kill regressed to a calm drain?
   This is the fourth attempt at this test; be exacting.
3. **D3** — the one authorized production change: after a refused open the tee
   stops teeing (no per-item clone, no per-item warn, logged once), while the
   **inner persistence still receives every message** so host behavior is
   unchanged. Verify both halves, and that nothing else on the production path
   changed.
4. **D4** — `cargo check -p xai-grok-shell` (default features, the shipping
   build) is free of `grok-lhc-host` warnings, and the crash machinery is now
   `cfg`-gated out of that build.
5. **D5** — tee methods driven through the tee under async; `futures`/`serde`
   dropped from the manifest; repair and compaction tests now assert kind and
   payload; a current-thread C1 guard exists with a timeout.

## Orchestrator's own edit — audit it

I applied one change myself as trivial residue: three `#[allow(clippy::await_holding_lock)]`
attributes with justification comments on the async tests in
`tests/certification.rs` (the `env_lock` std guard spans the `timeout(...).await`,
but the awaited body is entirely synchronous). **Judge whether that
justification is actually true** — if any of those three awaited bodies can
suspend, the allow is masking a real deadlock risk and you should say so.

## Regressions

Confirm the round-5 changes did not disturb: B1's five acceptance cases; the
refuse-to-open paths; off-by-default; exactly 3 hooks + root workspace entry;
FORK.md carve-out numbers vs `git diff --numstat`; vendored submodule clean at
`e582465`.

## Settled — flagging these is a false positive

Ruling R1 (`Interjection`/`GoalSummary` → plain `runtime_note`); `is_error`
omitted; clippy warnings originating inside vendored `lhc`.

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

Note: use `--all-targets`. Earlier rounds reported "clippy clean" from an
invocation that did not lint the test targets and therefore missed real
warnings.

## Report

D1–D5, then the verdict on my own edit, then regressions, then a coverage
note. End with **PASS** (commit it) or **CHANGES REQUIRED**. If the only
remaining items are cosmetic, say PASS and list them as non-blocking notes —
do not hold the chunk for polish.
