# Chunk 3A fix round 4 — the cache refresh is not atomic

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

AA1's steady-state behaviour is confirmed correct and non-vacuous: disabled B
persisting 1000 times while A is active takes zero registry lookups, and both
Y1 probes pass. The multisession L3 defect is fixed **when registry membership
is stable**. This round is the unstable case.

---

## AB1 [blocking] `refresh_binding` publishes a handle and a generation that were never true together

`refresh_binding()` (`tee.rs:78`) does this:

1. `lookup_session()` — reads the registry **under its mutex**
2. mutex released
3. `registry_generation()` — read **after** the lock is gone
4. stamps the step-3 generation onto the step-1 handle

A registration landing between 2 and 3 lets a stale value — **especially
`None`** — be stamped with the *new* generation. Every subsequent persist then
sees matching generations and never refreshes again.

Proven by forced interleaving with temporary delay instrumentation:

- B's refresh looked up `None`
- B registered while the refresh was paused
- the refresh recorded B's **post-registration** generation next to the cached
  `None`
- a later B persist never reached LHC
- probe output: `events=1`, bootstrap only — the post-enable event absent

**This silently breaks Y1.** Mid-session `/lhc on` appears to succeed and
captures nothing. It can also leave tee `Drop` trusting the cached `None` and
failing to shut down a worker that is actually running.

### Requirement

The cached `(generation, handle)` pair must be a **snapshot that was true at one
instant**. Never assemble it from two separate observations.

Preferred: a registry helper returning `(generation, Option<CaptureHandle>)`
**while holding the same registry mutex**, so the pair is atomic by
construction. That keeps the fast path unchanged — still one atomic compare in
steady state — and confines the change to the slow path.

An acceptable alternative, if you prefer it, is to read the generation
**before** the lookup and re-check it after, retrying while it moved. Reading
generation-first fails safe (a stale-but-older generation forces another
refresh) whereas generation-last fails unsafe (a stale value looks current).
Say which you chose and why.

### The test must pin the interleaving, not just the outcome

A test that registers and then persists will pass with the broken code — the
race needs the registration to land inside the refresh window. Make it
deterministic rather than timing-dependent: a test-only hook, a barrier, or an
injected pause between the lookup and the generation read.

**Then demonstrate it fails on the old code.** Break-watch-restore, with the
verbatim failure output in your report — the same discipline the vacuous-test
rounds established. A race test that cannot fail is worse than none, because it
certifies the thing it never exercised.

### Also check the symmetric case

The proof used registration during refresh. Check **unregistration** during
refresh too — a stale `Some(handle)` stamped with a new generation, pointing at
a worker that has gone. `is_closed()` may cover it; say whether it does, and if
so, why that is guaranteed rather than incidental.

---

## Confirmed this round — no work needed

- **Teardown mutex: fine.** `clear_last_serve_outcome()` takes the status-map
  mutex once at tee teardown, not on the persist path; it does not contradict
  the committed disabled-persist law.
- **Generation wrap at `u64`:** not operationally material.
- **AA1 counter test:** valid and non-vacuous.
- Registry lifetime, Z1–Z4, Chunk 2: settled.

---

## Report

Position against the full project. Lead with the snapshot mechanism you chose,
the deterministic interleaving test, and its verbatim failure output against the
pre-fix code. Confirm Y1 still holds from both spawned-off and off-then-on, and
that AA1's counter assertion is still zero. Full suite counts, both fmt gates,
`--all-targets` clippy attributed, hooks 6/6, no seventh touchpoint, vendored
port untouched.
