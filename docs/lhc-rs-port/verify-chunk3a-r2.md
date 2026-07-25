# Chunk 3A re-verification — after fix round 1

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

You verified Chunk 3A previously in this same session. This is the same chunk
after a fix round. You have your own prior context; use it however you judge
best. Nothing below narrows what you may examine — it is a description of what
changed, not a list of what to look at.

## Tree isolation

Two lanes, **separate trees** — one in `/srv/work/grok-build`, one in an rsync
copy. State which tree you measured. Mutate freely; restore and say so. If
files change under you mid-run, that report is authoritative.

## What changed

All seven items from the previous round were addressed. Current gates: 148 lib,
82 certification, 5 goldens, both fmt, clippy `--all-targets` clean, tripwire
green at 6/6 hooks.

- **Y1 — `/lhc on` now captures.** The tee always installs and resolves its
  worker per persist via `lookup_session(sid)` behind the `any_capture_active()`
  fast path, rather than capturing a handle at construction. **The registry
  entry also changed from `Weak` to a strong `Arc`** — the implementor reports
  that dropping spawn's return value was killing the worker immediately, which
  is why probe B failed until that change. Both probes now drive the product
  path through the tee: spawned-off → enable, and on → off → on.
- **Y2 — status follows the last serve turn** (`note_last_serve` in
  `serve_request_context`), not capture registration: `LHC` / `native` +
  fail-open reason / `(no serve turn yet)`, bound to the timeout fail-open case
  by a test.
- **Y3** — `apply_resolved_config` no longer sets env for default-sourced
  values; root provenance reads the applied snapshot when env is unset.
- **Y4** — `plan_repair` stores the displayed plan; `execute_repair` runs only
  a matching stored id.
- **Y5** — schema validated (SQLite magic + version); a garbage file reports
  degraded.
- **Y6** — `config/tests.rs` added to the patches regen list.
- **Y7** — `GROK_LHC=on` now accepted by the gate; a malformed `[lhc]` section
  records a parse error instead of faking config provenance.

## One thing I found and could not fully settle

I checked the `Weak → strong Arc` change myself. Cleanup is explicit
(`shutdown()` / `crash_kill()` take `self`) rather than `Drop`-based, so it does
**not** create the refcount cycle where a registry-held strong ref prevents the
`Drop` that would unregister it. Worker-exit paths call `unregister_worker`
independently.

What I could not resolve: **I found no LHC shutdown call on the host's
session-end path.** Under `Weak`, an entry went stale on its own when the owner
dropped. Under a strong `Arc`, an ended session's entry appears to stay
registered for the process lifetime, holding a worker thread and its SQLite
connection — and a long-lived shell creates many sessions. I may be wrong about
the ownership or missing the cleanup path. Confirm or refute it against source.

## Carried to 3B — not blocking here

Unknown `/lhc` subcommands falling through to Status and `repair confirm`'s
case-sensitivity; the status early-return asymmetry; and
`refresh_settings_and_reapply` re-entering `apply_resolved_config` on `/new`
with tokio workers live. Each is recorded in the 3B brief with a checkpoint.

## Standing scope

Chunk 2 (`817472b`) is committed and settled — write-back, the typed provenance
classifier, dedup, hook 4's existence, the fingerprint pinning. G2 is a 3B
checkpoint. Live certification is 3B: findings that 3A defers there with a
named checkpoint are not blocking.

## Run and report actual output

```
scripts/check-lhc-hooks.sh
cargo test --features test-util --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo check -p xai-grok-shell
cargo fmt -p xai-grok-shell --check
cargo fmt --check --manifest-path crates/lhc/grok-lhc-host/Cargo.toml
cargo clippy --manifest-path crates/lhc/grok-lhc-host/Cargo.toml --all-targets --features test-util
```

Confirm hooks stay 6/6, no seventh touchpoint, vendored port untouched at
`e582465`, and that Chunk 1/2 invariants still hold.

## Report

**Lead with: CHUNK 3A — PASS or CHANGES REQUIRED.** Classify each finding as
**blocking** (the product is wrong) or **carryable with a named 3B
checkpoint**. Give your verdict on the registry-lifetime question. If you pass
it, say what 3B's live certification must confirm.
