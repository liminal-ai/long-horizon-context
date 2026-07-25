# Phase 4 / Chunk 2 — adversarial verification (independent lane)

You are one of **two independent verifiers**, running in your **own copy of
the tree**. You will not see the other's report and it will not see yours.
**Findings only.**

## Position

Project = 22 units. **Chunk 2 = unit 21 of 22** — the LHC compact bridge.
Chunk 1 (capture, unit 20) is committed at `86e9873220`; Chunk 2a (census +
band-shape harness) at `b0319a5fe8`. Chunk 3 (live certification, unit 22)
follows and is the only unit that delivers a usable result.

## Subject

The **uncommitted** Chunk 2b working tree: the LHC compact arm and write-back.

- The full diff vs `HEAD` is at
  `/tmp/claude-1000/-srv-work-codex/6ea2a00a-fbf9-40c6-96c8-8e8d737593c4/scratchpad/chunk2b.diff`
- New (untracked) files are listed in
  `…/scratchpad/chunk2b-untracked.txt`: `core/src/compact_lhc.rs`,
  `core/src/compact_lhc_tests.rs`,
  `lhc/codex-lhc-host/src/{compact_bridge,inference}.rs`,
  `patches/lhc/0007-lhc-compact-arm.patch`.

If your tree has `.git`, diff directly; if not, use those files.

## Read first

1. `FORK.md` in the fork root — laws and touchpoint/tripwire discipline.
2. `phase4-impl-chunk2b.md` (this directory) — the brief this work is
   measured against, including three orchestrator rulings.
3. `codex-rs/lhc/CHUNK2-CENSUS.md` — the consumer and fail-open census.
4. `phase4-codex-integration-brief.md` §"Laws from the Phase 3 Chunk 2
   escalation" — this chunk is where those laws bite.

## What to attack

1. **Law 1 — one conversation state.** `lhc_compact_arm_writeback_equals_body_law1`
   claims host state *equals* the LHC body after a compact. Does it? Break
   the write-back (install a body that merely resembles LHC's) and see
   whether the test fails. Two-truths is the failure mode that broke Grok
   Build Chunk 2; verify there is no path where host and LHC serve different
   conversations.
2. **Law 2 — accounting.** `lhc_compact_arm_clears_prefill_law2` is claimed
   to cover the LHC arm. Is the threshold genuinely *untripped* — compact
   once, counter drops, **no re-trigger on the next turn** — or does the test
   only assert `prefill == None` immediately after? The brief required the
   next-turn property; a one-shot prefill check is not it.
3. **Fail-open bounds (law 3).** Claimed: feature off / no slot / degraded /
   handle-not-ready / empty body / `>512` items all fall back to the native
   ladder. Verify each **actually** falls back, and that no path can install
   an oversized or unbounded body. Where did `512` come from — is it a
   bound that fits the context window, or a number? A fallback that produces
   an oversized body is precisely the Grok Build defect.
4. **Test thinness — the highest-yield attack.** There are 5 substantive
   tests for an entire compact bridge. The brief (item 5) required goldens
   under band-shaped history for the census's shape-risk consumers:
   resume/reconstruction **byte-for-byte**, full-history and last-N forks
   (including `/btw`, which is a fork in Codex), guardian transcript and
   guardian fork, and same-session code review. Only
   `band_body_is_verbatim_replacement_history` appears to address any of
   them. Enumerate precisely what is and is not covered, and construct the
   failure each missing golden would have caught.
5. **Constant-against-itself.** `compact_lhc_tests.rs:177` asserts
   `RENDER_SEAM_ID == "band_shaped_history_from_events/v1"`. The Phase 4
   brief names this exact anti-pattern ("Grok's only test for its
   rewind-critical invariant asserted a constant against itself"). Find any
   others.
6. **The reconciliation marker.** The orchestrator ruled that the write-back
   must NOT be re-ingested, and that the archive instead records a compact
   marker. Verify: exactly one marker per compact (the test asserts 1 — is
   that robust under retry/crash?); the write-back genuinely does not
   re-enter capture; and the archive can still answer "what was served and
   from which events was it derived". Does the marker survive restart?
7. **Ladder placement.** LHC arm above `Feature::TokenBudget` in BOTH the
   manual ladder (`tasks/compact.rs::run`) and the auto path
   (`session/turn.rs::run_auto_compact`). Verify both, and that the arm is
   genuinely reachable in each. Half-wiring here means auto-compact silently
   keeps native behaviour.
8. **The render seam.** Ruling 3 required the band render to be one
   swappable seam so the pending band-shape eval can change it in one place.
   Are shape assumptions genuinely confined to `render_served_body`, or have
   they leaked into the arm?
9. **`!Send` handling.** LHC futures are `!Send`, handled with an OS thread +
   current-thread runtime. Check for deadlock, blocking of the async
   executor, cancellation-safety, and what happens if that thread dies
   mid-compact.
10. **Sentinels / patches / FORK.md.** New hooks 11–13 plus a `core/Cargo.toml`
    runtime dep. Is `EXPECTED_HOOKS` correct, the inventory truthful, and
    `patches/lhc/0007` regenerated and applicable? Note that a **runtime**
    (not dev) dependency from `codex-core` on the adapter is a bigger
    coupling than Chunk 1's — is it justified, and does it risk a cycle?

## Standing bar — this is what caught Chunk 1

- **Rule zero:** anything certifying what LHC records must round-trip
  through a real `LhcSession` and read the stored row back; anything
  certifying core behaviour must run through core's production path.
- **`include_str!` source-text assertions are banned as certification.**
  Chunk 1's fix round 4 removed five of them; report any that returned.
- **Vacuity:** for every test guarding a hard invariant, break the
  production code, run it, and record the real output. Do not argue.
- **Fixture faithfulness:** fixtures must be shapes the host can produce.

## Rules

- Verify by running things. Building and running tests is expected.
- You are in your own tree — mutate freely, but restore exactly and confirm
  the tree matches its pre-check state. Do not commit or push.
- Where a finding conflicts with a recorded ruling in FORK.md or the brief,
  the ruling wins — cite it.

## Report

Findings only, severest first: `file:line`, one-sentence defect, concrete
failure scenario, severity (BLOCKER/MAJOR/MINOR), CONFIRMED vs SUSPECTED.
End with a coverage note: reviewed line-by-line vs skimmed vs not opened,
and which tests you actually executed.
