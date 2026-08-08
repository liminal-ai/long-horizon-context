# Chunk 3B fix round 7 — R3 root cause, and the honest option

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22.**

Only read this if R3 from round 6 is not already resolved this way.

## R3 root cause (independently established, both lanes)

`drain_derivations_before_compact` (`session.rs:436`) is:

```rust
tokio::select! { biased;
    _ = cancel.cancelled() => …,
    result = timeout(drain_settled()) => …,
}
```

On cancel the **drain arm is dropped** — and that arm owns the in-flight sample
future — before the inner future is polled again. So the sampler's own
`cancel.cancelled()` branch can never complete. On the capture worker's
current-thread runtime the outer drop always wins.

**The registry token is structurally unreachable on this path**, not untested.
Proof from a probe sampler that records whether the token *it was handed* fired:

```
PROBE-CANCEL: sampler's OWN token fired = false
PROBE-CANCEL: sample future dropped WITHOUT its token firing = true
```

Deleting the single `install_compact_cancel(...)` call leaves Q1 passing and the
compiler reporting `function install_compact_cancel is never used`.

## What is actually wrong

**Behaviour today is correct.** Dropping the future drops the reqwest future, so
the remote call stops and no write-back happens. The defect is the *claim*:
MAPPING.md, FORK.md and the rustdoc describe an operative token-based
cancellation path for in-flight sampler calls; the registry and `ClearCancel`
guard read as live code; and the certifying test survives their deletion.

## Preferred fix: delete the claim, not the behaviour

**Remove `install_compact_cancel` / `compact_cancel_for` / the cancel registry
and the `ClearCancel` guard, and document cancellation as drop-based** — the
drain future is dropped, which drops the in-flight HTTP request. That is what
happens, it is correct, and it needs no new machinery.

Then make the test assert the property that is actually true and load-bearing:
after abort, **no further sampler operations occur and no write-back is
installed** — and have it fail if the drop path is broken (e.g. if the drain were
detached with `tokio::spawn` so cancel no longer dropped it).

Restructuring so the inner future observes the token is acceptable instead, but
it is more machinery for the same user-visible outcome. If you take that route,
the probe above must show `sampler's OWN token fired = true`.

Do not leave documentation describing a path that does not execute.

## Report

State which option you took, the break-watch-restore output, and the exact doc
edits. Full suite counts, both fmt gates, `--all-targets` clippy attributed,
hooks 6/6, no seventh touchpoint, vendor `e582465` untouched.
