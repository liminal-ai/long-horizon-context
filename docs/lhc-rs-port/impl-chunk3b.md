# Chunk 3B — certification: the harness track

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.** This is the second half of
the final chunk. Its sign-off, plus the live track, is what closes Phase 3.

Do not start until told 3A is accepted.

## The split, and why

Chunk 3's done-definition requires long live sessions with **actual sampling**
on Lee's fork. That needs Lee's credentials and Lee's real usage; it is his to
run, and it is being packaged separately as a runbook.

**Everything else is mechanically certifiable here, and most of it does not
need credentials at all.** The port exposes
`create_deterministic_inference_callbacks()`
(`vendor/.../shared_tech/deterministic.rs:108`), and `SdkConfig` accepts
`inference_callbacks` as an **XOR alternative** to real inference config
(`vendor/.../sdk.rs:1030,1055-1058`). So a harness can drive a **real
compaction end to end** — real `ChatStateActor`, real write-back, real capture,
deterministic summaries — with no network and no credentials.

That is the difference between "we tested the adapter" and "we tested the
product", and it is what this brief is for. Build the harness track so the live
track only has to confirm what the harness already proved.

## Standing rules

Unchanged and binding: work uncommitted on branch `lhc`; vendored port
read-only; C2 (report out-of-scope findings, don't fix); no wildcard `_ =>`
over host enums; hook changes update sentinel + FORK.md inventory + `patches/`
in the same change; **off-by-default means behaviourally identical with no
added per-turn work**.

## B1 [blocking] The live harness — the checkpoint everything has been deferred to

Build a harness that drives a **real** Replace-mode compaction through the real
host path: real `ChatStateActor`, real `replace_conversation_for_compaction`,
real capture tee, deterministic inference callbacks. Then capture what actually
flows.

This discharges the ruled **G2** checkpoint, which has been deferred twice and
is the single highest-value item in Chunk 3:

- **Capture the real write-back body** — item shapes, ordering, system prefix,
  `prompt_index` markers — from an actual compaction run.
- **Diff it against the adapter-simulated body** the Chunk 2 gate tests use
  (`writeback_fixture()` and the realistic post-compact fixtures built in the
  H2 round).
- **If they differ: regenerate the gate fixtures from the real body and rerun
  all five gate properties against it.** Report exactly what differed. A
  difference means the Chunk 2 hard gate was measuring something the host never
  produces — which is precisely the failure mode that hid the fixpoint defect,
  and it would be a Chunk 2 finding surfacing late, not a Chunk 3 nicety.

Then run the five gate properties on the harness, not the adapter simulation:
fixpoint, prune-emits-nothing, summary-exactly-once, repeated-unchanged-nothing,
crash-no-double-record.

## B2 [blocking] Chunk 1's scheduled blind spots

FORK.md now lists these as **scheduled verification at the Chunk 3
checkpoint**, not accepted limitations. This is that checkpoint. Discharge
them:

1. **Hook-2/hook-3 session-id coupling** — verifiable only by inspection until
   now. The harness makes it executable: prove capture attributes events to the
   right session across spawn, resume, and fork, and that no cross-session
   leakage occurs.
2. **Async guards catch panicking but not silent blocks** — still open from
   Chunk 1. Determine whether the harness can produce a silent-block case and
   detect it. If it genuinely cannot, say so with the reason; do not paper over
   it.

## B3 [blocking] The `/btw` and memory-flush ruling

Lee ruled these are not hooked because they read native state, which after
write-back holds the LHC body. **Chunk 3 live cert must explicitly check both
on a compacted session** — that was a condition of the ruling.

Drive a session through compaction on the harness, then exercise `/btw`
(`session/acp_session_impl/recap.rs`) and memory flush (`memory_dream.rs`).
Confirm each receives the LHC-compacted body and behaves coherently. **If
either misbehaves, it reopens as its own decision — report it, do not fix it.**

## B4 [blocking] The end-to-end paths in the done-definition

The Phase 3 brief names these explicitly. Exercise each on the harness, and
state honestly which cannot be reached without live sampling:

CLI and ACP paths; leader/subagent; session resume and import; model switch;
manual (`/compact`) and automatic compaction; shutdown and crash recovery.

Evidence requirements from the done-definition — assert each, don't assume it:
**no dangling tool calls, no lost turns, no duplicate events, no cross-session
state, no SQLite corruption, no leaked background tasks.**

Crash recovery specifically must cover the window Chunk 2 identified: a crash
between LHC's `compact()` commit and the native replace. It was assessed as
transient-and-self-correcting; prove it on the harness.

## B5 [blocking] Rollback and the reversibility question

3A documents a rollback procedure. Execute it here: enable LHC, run a session
through compaction, disable LHC, and confirm the session continues coherently
on the native path.

Then answer the question 3A was asked to state plainly: **after a write-back
compaction, what is recoverable?** Write-back rewrites the native conversation.
If turning LHC off leaves the user on a body LHC produced, say so — that is not
necessarily wrong, but it must be documented, and it bears on "no irreversible
migration before validation". If the pre-compaction body survives in
`updates.jsonl` or LHC's event log, prove it by recovering one.

## B6 [major] Equivalence evidence

Run the harness with the equivalence instrumentation armed and report
`equivalence_snapshot()`: turns served and compared, turns fallen back,
structural divergences, informational divergences.

This is evidence toward the ruled hook-4 removal, **not** the decision — the
ruling requires live-cert evidence, and harness evidence is a leading
indicator. Report the numbers plainly. **A non-zero informational divergence is
a finding: report it, do not fix it.** A high fallback count is also a finding.

## B7 [major] Performance and health

The Phase 3 brief says to measure during live cert rather than pre-optimise.
On the harness, measure: per-turn overhead with LHC on versus off, compaction
wall-clock, storage growth per turn, and worker backlog under sustained load.
Report numbers, not adjectives. Confirm no leaked background tasks at teardown.

## What to hand the live track

Produce a list of exactly what the harness could **not** prove and therefore
what a live session must confirm — with, for each item, what to run and what
would constitute failure. Keep it short and executable; it becomes Lee's
runbook. Be honest: an item you could not test is more useful named than
quietly dropped.

## Report

Position against the full project (Chunk 3 of 3, Phase 3 of 4, unit 18 of
~22). For B1–B7: what you built, what it proved, what it did not. Lead with
B1 — whether the real write-back body matched the fixtures, and if not, what
differed and what re-running the gate against the real body showed. Then the
blind spots, the `/btw`/memory-flush verdict, the done-definition evidence
table, rollback and recoverability, equivalence numbers, and performance
figures. End with the live-track handoff list.

---

## B8 [blocking] Pre-registered live-cert watch items

Carried from the Chunk 2 final acceptance review. These are **predictions
traced from source, not established facts** — confirm or refute each, and do
not let one masquerade as a new discovery mid-cert.

### B8.1 — The zero-divergence reading that means nothing

**This is the easiest number in the whole cert to misread.** A hook-2/hook-3
session-id mismatch produces **zero compared turns**, which in a summary reads
**identically to a clean run**: `informational_divergences == 0`.

**Rule: never read `informational_divergences == 0` as evidence without first
asserting `turns_served_and_compared > 0`.** That distinction is the entire
reason the fallback counter exists. Report both numbers together, always, and
report the **ratio** `turns_fallen_back : turns_served_and_compared` — a high
fallback ratio means the zero-divergence pile is thin no matter what the
divergence counter says.

This also discharges part of B2: the session-id coupling is inspection-only
today, and the equivalence counters **cannot** catch a mismatch on their own.

### B8.2 — Expected informational divergence that is capture encoding, not a serving bug

`mapping.rs:442-455` wraps tool arguments that are not JSON objects: malformed
→ `{"raw": "<original>"}`, non-object JSON → `{"value": <parsed>}`. On the serve
side those return **wrapped**, while the native side canonicalizes the original
bytes to themselves. So a truncated or non-object tool-argument payload projects
as:

```
native : [tool call · x] {not json
served : [tool call · x] {"raw":"{not json"}
```

and **fires informational divergence** — correctly, in that the model really
would see different text, but as a **capture-encoding artifact**, not a serving
defect.

Standing rule says the first informational divergence goes to Lee. **This shape
is pre-registered**: triage it as encoding and report it as such. If it turns
out to be something else, escalate then.

### B8.3 — G2 re-verifies calibration, not just fixtures

Already mandatory, with an addition. Every equivalence result from Chunk 2 rests
on **renderer-faithful fixtures**, not a captured live Replace body. If the live
body differs from the fixtures, it is **not** sufficient to regenerate the
fixtures and re-run — the instrument's **calibration** must be re-verified
against the real body, because the canonicalization and fingerprint were tuned
against fixture shapes.

### B8.4 — Coverage gaps to close on the harness

- **No equivalence test drives the served side through real serving code with
  argument-bearing tool calls.** `equiv_post_writeback_band_collapse_informational_silent`
  uses real `decide_substitution` but its window has no tool arguments. One
  harness test feeding `decide_substitution` output (live-tail tool call with
  args) against a native body holding **pretty-printed provider bytes** turns
  source-reading into proof. Chunk 2 round 13 addresses the unit-level version
  of this; the harness is where it becomes real.
- **`equiv_tool_window_structural_only`** builds its served side by
  round-tripping the projection, so its informational-silence assertion is a
  fixpoint property of the projection rather than evidence about serving.
  Harmless, but it **carries no weight toward the removal ruling** — do not
  count it.
- **Monotonic merge** has unit coverage only.
