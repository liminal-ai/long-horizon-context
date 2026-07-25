# Chunk 1 fix round 4 — one blocking regression, self-inflicted

**Chunk 1 of 3, Phase 3 of 3 — unit ~16 of 18.**

B1–B6 all look correctly implemented and I am not asking you to revisit them.
53 tests, fmt clean, clippy clean, tripwire green including 29 certification
tests — that part is real progress.

But the round shipped a **session-killing panic on the enabled path**, and it
came from a change you made that I did not ask for.

---

## C1 [blocking] `spawn_capture` blocks the host's async runtime — panics at session spawn

You wrote: *"One product fix beyond the letter of B2: `spawn_capture`
previously returned a handle even when `open` failed (zombie drain). It now
blocks on open success and returns `None` on refuse."*

`capture.rs:567` — `opened_rx.blocking_recv()`. That call sits on the
production path: `spawn_capture` ← `tee_chat_persistence` ← **LHC-HOOK 2/3**
in `spawn_session_actor`, which is an `async fn` on the host's tokio runtime.
`tokio::sync::oneshot::Receiver::blocking_recv` panics inside an async
context. This is the **exact hazard identified as F4 in round 1 and fixed in
round 2** — now reintroduced one layer up.

I proved it rather than inferring it. A probe calling `tee_chat_persistence`
from a `#[tokio::test(flavor = "multi_thread")]` — the host's real call shape —
with `GROK_LHC=1`:

```
thread 'tee_from_async_context_like_the_host_does' panicked at
  crates/lhc/grok-lhc-host/src/capture.rs:567:28:
Cannot block the current thread from within a runtime. This happens because a
function attempted to block the current thread while the thread is being used
to drive asynchronous tasks.
```

So with the feature **on** — the deliverable's primary path — every session
spawn panics. Your 53 tests pass because every one of them calls
`spawn_capture` from a synchronous `#[test]`, where `blocking_recv` is legal.
The entire suite is blind to the only calling convention that ships.

### Fix

1. **Never block the caller in `tee_chat_persistence` / `spawn_capture`.**
   Return the handle immediately, as before.
2. Keep the B2/B5 refuse-to-open semantics, but make them observable without
   blocking the host. The worker already unregisters itself on refused open,
   so `capture_active(session_id)` becomes false shortly after — that is the
   observable signal, and it is what tests should assert. If you need the tee
   to stop teeing after a refused open, have the tee consult the shared state
   the worker sets, not a rendezvous with the parent.
3. If you genuinely believe a synchronous open-confirmation is required,
   **stop and say so** with the reason — do not solve it by blocking.

### Permanent regression guard — required, not optional

Add my probe to the suite as a real test (name it something like
`tee_from_async_context_does_not_block_or_panic`): construct a
`#[tokio::test(flavor = "multi_thread")]`, enable the gate, call
`tee_chat_persistence` exactly as hook 2 does, and assert it returns normally.
Then add the mirror case for teardown — drop the returned tee **inside** the
same async context and assert no panic.

This class of bug has now appeared twice. From here on, the suite must contain
at least one test that exercises the adapter through the host's actual calling
convention (async runtime, not `#[test]`), so it can never regress silently
again. Say in your report which tests now cover it.

## C2 [process] Do not make unrequested product changes

The zombie-drain observation was a good catch and I would have taken it as a
finding. But you implemented it, on the production path, in a round whose
scope was six enumerated items — and it broke the deliverable in a way your
own tests structurally could not see.

For the rest of Chunk 1 and into Chunks 2–3: if you spot something outside the
brief's scope, **report it, do not fix it**. The cost asymmetry is stark — a
reported finding costs me one paragraph of adjudication; an unrequested change
costs a full verification round and, this time, nearly shipped a panic on the
one path Lee will actually run.

---

## Report

Position against the full project. State: how C1 was fixed, which tests now
exercise the async calling convention (both spawn and teardown), and
confirmation that the refuse-to-open semantics from B2/B5 still hold without
blocking. Re-run fmt, clippy, the full suite, and the tripwire, and give
actual counts.
