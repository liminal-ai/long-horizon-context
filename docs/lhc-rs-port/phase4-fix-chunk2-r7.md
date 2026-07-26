# Phase 4 / Chunk 2 — fix round 7

Resume the same session. **Do not commit, do not push.**
Position: **unit 21 of 22.**

Both verifier lanes, independently, in separate trees, found the same thing
from opposite directions. I verified it myself. It is the most important
finding of this chunk.

---

## L1 — BLOCKING. LHC derivation is never triggered. The entire inference
path is dead code and every compact is fully degraded

`compact_bridge.rs:702` calls:

```rust
session.lhc.drain_settled(session.thread_ref.clone()).await;
```

`drain_settled` (`sdk.rs:677` → `scheduler.rs:1128`) **waits for the
scheduler to become idle**. It does not schedule work and it does not run
derivation. The calls that actually derive are `lhc.work.drain(ref, opts)`
(`sdk.rs:147`) and `derive` / `derive_turn` / `derive_detailed_chunk` /
`derive_brief_chunk` (`sdk.rs:434,618,631,644`).

I grepped the adapter myself. Neither `work.drain` nor any `derive*` is
called anywhere in `codex-lhc-host`:

```
session.rs:205:      self.lhc.drain_settled(...)
compact_bridge.rs:702: session.lhc.drain_settled(...)
```

That is the complete list.

**Consequences, all confirmed:**

- Every band is the **degraded excerpt** fallback, never model-derived text.
  That is why the live eval artifact showed
  `[degraded: smooth-from-excerpt]`.
- The other lane proved the inference path is inert: callbacks that return
  `Err` on every call, and callbacks that block forever, both produced
  `Installed` in ~270 ms with `degraded_items=1`. The callbacks are never
  invoked.
- So J1 and J2 — real inference as the default, luna pinned at lowest effort
  — are correctly plumbed and **never execute**. Lee's instruction was "real
  inference for derivations, not shims." This is the shim, one level below
  where we were looking.

**Ruling:** trigger derivation before compacting.

1. Call the real derivation path (`lhc.work.drain(ref, opts)`, or the
   specific `derive*` entry points if that is the better fit) **before**
   `thread_view.compact()`, so bands are model-derived rather than excerpt
   fallbacks.
2. Keep `drain_settled` if it is still needed to await quiescence — but it is
   not a substitute for running the work.
3. Derivation failure must **fail open** to the native ladder
   (`Unavailable`), never install a degraded body silently. See L2 — same
   rule, and they should share one mechanism.
4. If a compact legitimately has nothing to derive, that is fine; the test
   must distinguish "nothing to derive" from "derivation never ran".

**Test — must be behavioural and must fail if the derivation call is
removed:** run a real compact and assert the produced bands are
**model-derived**, not `degraded`. Assert `degraded_items == 0` for a body
where derivation should have succeeded, and that the inference callbacks were
actually invoked (count them).

**Cost discipline — binding.** Wiring this makes compacts hit the API for
real. Before any live run, estimate tokens from history size x turns and
state it. Keep test histories small. Report actual usage. **If a planned run
would exceed ~50k tokens, stop and ask.** Lee's authorised eval already
overran 12x because nobody bounded input size; do not repeat that.

---

## L2 — BLOCKING. Inference failure after client resolution installs a
fallback body instead of failing open

`compact_lhc.rs:141`, `lhc_inference_bridge.rs:233`. Client *resolution*
failure correctly returns `Unavailable`. But once compaction has started, an
inference error is handed to LHC, which substitutes its internal fallback and
returns an installable body — so connection loss, auth expiry, or rate
limiting silently degrades content instead of reaching Codex's own
compaction.

**Ruling:** latch it. If any derivation call fails during a compact, the arm
returns `Unavailable { reason }` at `warn` and the native ladder runs. Law 3:
degrade to Codex's real compaction, never to degraded LHC content.

**Test:** callbacks that error mid-compact → `Unavailable`, native ladder
reached, nothing installed, no marker.

---

## L3 — BLOCKING. The 512-entry provenance cap can evict current-body ids,
re-opening the re-ingest defect

`install.rs:52`, `compact_lhc.rs:309`. `SESSION_DERIVED_CAP = 512` drops
arbitrary ids, and reseeding is skipped whenever the cache is non-empty. A
long enough session evicts ids belonging to the **current** body and
re-imports it as native history.

Proven by mutation (cap 512 → 8):

```
round 1: archive source events must stay at 160, got 182
```

This is my H3 ruling creating a correctness hole — I asked for a bound and
did not say what must never be evicted. Correcting that now.

**Ruling:** the cap may never evict provenance for the **current** body.

- Bound the structure by all means, but the current body's ids/digests are
  pinned and exempt from eviction.
- Evict only entries superseded by a later compact.
- Reseeding must not be skipped merely because the cache is non-empty —
  the durable record is the source of truth; the cache is an optimisation.
- Log evictions (H3's rule stands).

**Test:** with a deliberately tiny cap, run several compacts and assert no
re-ingest. Must fail if current-body pinning is removed.

---

## Standing bar

- Tests round-trip the production path. No `include_str!`. No test that
  cannot fail.
- Every invariant proven by mutation: break it, paste the failure, restore,
  re-pass. Paste real output.
- **Do not run workspace-level `cargo fmt`** — it dirties the vendored
  submodule pin. Use `-p codex-lhc-host`.
- Do not commit, do not push.

## Escalate rather than improvise

If wiring real derivation reveals that LHC's work pipeline needs
configuration we have not set (worker registration, model assignment,
profiles), report what is missing rather than stubbing it. A stub here is the
exact defect this round exists to remove.
