# Chunk 2 fix round 6 — the equivalence evidence must exclude fail-open turns

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

J1–J4 accepted. Verified independently: tripwire 6/6, 58 certification + 5
goldens, adapter clippy clean under `--all-targets` (all remaining warnings are
in the vendored port — settled false positive), and hook 4's observation is
genuinely observe-only: the report is discarded, `request.items` is assigned
from `apply_serve_decision` regardless, and the clone only happens when
armed inside the `capture_active` gate.

One defect in the evidence design, found in my pass. It is small, but it goes
to the soundness of the ruling's own removal criterion.

---

## K1 [blocking] Fail-open turns must not count as zero-divergence evidence

**The problem.** `observe_serve_equivalence(session_id, turn_index,
compact_occurred, native, served)` has no way to know whether substitution
actually happened. When `serve_request_context` returns Native — fail-open,
timeout, LHC unavailable, or serving simply declining — `apply_serve_decision`
returns the native items unchanged, so `served == native` and **both
divergence counters read false**. That turn is then recorded as clean
equivalence evidence.

**Why it matters.** The ruling is: *zero divergence through Chunk 3 live cert
→ hook 4 comes out.* A long-session cert where LHC frequently fails open would
accumulate a large pile of "no divergence" turns that prove nothing about
whether the served view matches native, because nothing was served. The
evidence would look strongest exactly when the hook was doing least. That is
the wrong direction for a criterion whose whole purpose is to justify removing
a touchpoint.

**What to build.**

1. Pass the substitution decision into `observe_serve_equivalence` — the
   `substituted` bool that `apply_serve_decision` already returns.
2. **Only count and log a turn as equivalence evidence when `substituted` is
   true.** A fail-open turn is not evidence; it is a different fact.
3. Track fail-open turns in their **own** counter (`serve_fallback_turns` or
   similar) so the Chunk 3 report can state both numbers: how many turns were
   actually served and compared, and how many fell back. The removal decision
   needs the first number to be meaningful, and a high second number is itself
   a finding worth surfacing.
4. Tests: a fail-open turn must **not** increment either divergence counter
   **and must not** be recorded as a compared turn; a substituted turn must be
   compared as it is today.

Keep everything else as built — the two-signal split, the canonical
projection, the `capture_active` gate, `GROK_LHC_EQUIVALENCE=0`, and
observe-only semantics are all correct and verified.

## K2 [minor] Make the evidence self-describing

Whatever the Chunk 3 live cert reads must be able to state, without
reconstruction: turns served and compared, turns fallen back, structural
divergences, informational divergences. If that means a small accessor
alongside the existing counters, add it. The point is that the removal ruling
can be evaluated from the instrument's own output rather than from inference.

---

## Report

Position against the full project. State the counter set and what each one
means, and name the test that would fail if a fail-open turn were counted as
compared. Confirm no change to serving results, dedup, or the capture tee.
