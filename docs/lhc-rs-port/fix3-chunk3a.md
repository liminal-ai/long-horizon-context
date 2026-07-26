# Chunk 3A fix round 3 — Z5 was wrong, and the benchmark hid it

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

Z1–Z4 are confirmed fixed and are not in scope. This round is one defect.

**My Z5 ruling was wrong on the facts, and I am reversing it.** I ruled the
disabled path costs "one relaxed atomic load", verified that reading
`with_handle`, and missed that the guard is process-wide while the tee is
per-session.

---

## AA1 [blocking] A disabled session takes the global registry mutex per persist

`any_capture_active()` (`tee.rs:63`) is **process-wide**; `LhcTeePersistence` is
**per-session**. So:

1. Session A has LHC enabled → `ACTIVE_CAPTURES > 0`.
2. Session B is `/lhc off`, no worker.
3. B persists an item.
4. The process-wide atomic reads true — because of A.
5. B calls `lookup_session()` and **takes the global registry mutex**.

Confirmed by probe: one persist through disabled session B raised
`registry_lookup_count()` while A was active.

**This is Chunk 2's L3 defect reintroduced**, narrowed to multisession — which
is the normal state of a long-lived shell. The documented "one relaxed atomic
per disabled persist" exception is not the product's behaviour, so the restated
law in FORK.md/MAPPING.md is currently false.

### The benchmark hid it, twice over

- It only reaches the genuine disabled path when the **whole process** has zero
  captures, so it cannot observe this case by construction.
- Its number is not sound: single sequential tee-vs-bare loops,
  `tee.saturating_sub(bare)` masking every sample where bare ran slower, and
  five runs giving **0, 0, 0, 0, 7 ns** with the bare loop ranging 1.0–4.2 ms
  per 100k calls. The published 7 ns/call is noise, not a measurement.

### What to build

**Keep the unconditional tee** — the A5 reasoning stands, and no verifier
disputed it. The defect is the *guard*, not the architecture.

Requirement: **a disabled session must not consult the global registry on the
persist path, regardless of what other sessions are doing.** It must still pick
up a later `/lhc on` for its own session — that is Y1 and it must not regress.

Direction, but choose your own if it is better and say why: give the tee a
**per-session fast binding** — a cached handle plus a registry generation
counter bumped on every register/unregister. Fast path compares one atomic
against the cached generation and uses the cached value (including cached
`None`) without locking; the mutex is taken only when the generation actually
moved. That is one atomic in the steady state for both enabled and disabled
sessions, and it re-resolves exactly when registration changes.

Whatever you build, the property is: **no lock on the disabled persist path,
under any other session's state.**

### The measurement must actually measure

Replace the benchmark. It must:

1. **Cover the multisession case** — a disabled session persisting while
   another session is active. That is the case that was broken; if the test
   suite cannot fail on it, nothing stops it regressing.
2. **Assert the invariant directly, not by timing.** `registry_lookup_count()`
   already exists — assert it does **not** increase across N persists on a
   disabled session while another session is active. A counter assertion cannot
   be noise, and it is the property we actually care about.
3. If you keep a timing number, make it defensible: interleave or repeat, report
   a distribution rather than one subtraction, and never `saturating_sub` two
   independent samples. **A number that cannot distinguish 0 from 7 should not
   be published.** If you cannot make it defensible, drop it — the counter
   assertion is the real evidence.

### Then fix the documents

FORK.md and MAPPING.md currently state something false. Restate the law to
match what the code actually guarantees, and say plainly what the disabled path
does in a multisession process. Do not describe the intent — describe the
behaviour, and name the test that pins it.

---

## Report

Position against the full project. Lead with the mechanism you chose and the
counter-assertion output proving a disabled session takes no lock while another
session is active. Confirm Y1 has not regressed — mid-session `/lhc on` must
still capture, from both spawned-off and off-then-on. Full suite counts, both
fmt gates, `--all-targets` clippy attributed, hooks 6/6, no seventh touchpoint,
vendored port untouched.
