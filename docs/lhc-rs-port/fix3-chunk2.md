# Chunk 2 fix round 3 — instrument hook 4, and schedule the blind spots

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Write-back is in and the capture-tee loop passed its hard gate. Two rulings to
implement (Fable phase-reviewer, relayed by Lee 2026-07-25). Both are about
**producing evidence**, not about changing behavior — do not alter serving or
compaction semantics in this round.

Rules unchanged: uncommitted on `lhc`; vendored port read-only; C2 (report
out-of-scope findings, do not fix them); `GROK_LHC` off ⇒ host behaviorally
identical, and **the instrumentation must not violate that** — it is inside the
enabled path only, and must not add per-turn cost when LHC is off.

---

## G1 [blocking] Instrument hook 4 as "instrumented-redundant"

**Ruling:** hook 4 is being removed *by evidence, not by argument*. It stays
through Chunk 2 certification, demoted to instrumented-redundant. If it shows
zero divergence through Chunk 3 live cert, it comes out at Chunk 3 as a
touchpoint-set change. Any divergence is either a bug to fix or the documented
reason the hook stays.

Add an equivalence assertion at hook 4: **the served view and the
natively-built request body must be identical between compacts.**

### The measurement problem you must handle — read this before coding

A naive byte comparison of the two bodies will diverge on **every session that
uses tools**, for a reason that is already known and documented:
`LlmRequestContext` carries only `User`/`Assistant` roles with text parts
(`vendor/.../shared_tech/view.rs:173-200`), so the served body renders
structured tool calls as prose (`serving.rs:80-81`), while the native body
carries real `ToolCall` structures. That is a **structural** property, not a
bug and not evidence that the hook earns its place. If the instrument reports
it as divergence, the real signal drowns in it.

There is also **no existing normalization to reuse** — the golden diffs use
`project(events)` over mapped events (`golden_smoke.rs:52-59`), which is a
different comparison entirely. So you are defining this normalization.

### Therefore: measure two signals separately, do not pick one

Emit both, as separate counters and separate log classes:

1. **`structural_divergence`** — raw comparison of the two bodies (item count,
   kinds, roles, and byte-level text). Expected to be non-zero whenever the
   window contains tool calls. Log **once per session per class**, with the
   shape of the difference — never per turn, or it will bury everything else.
2. **`informational_divergence`** — comparison after a **canonical text
   projection applied identically to both sides**: each item reduced to
   `(role, canonical_text)`, with native tool calls and tool results rendered
   into the same textual shape LHC uses, thinking blocks handled identically,
   and whitespace normalized. This is the actionable signal: it answers
   *"does the served view carry different information than native?"* Any
   non-zero count here is a finding.

Define the projection in one place, apply it to both sides, and document it in
MAPPING.md — including explicitly what it normalizes away, so a reader can
judge what the evidence does and does not cover. **Do not normalize away
ordering, item count, or message content**; those are exactly what must be
compared.

Log every divergence **with the triggering state**: session id, turn index,
whether a compact has occurred, the counts on each side, and the first
differing item with its index.

Requirements:
- Armed in Chunk 2 certification **and** available for Chunk 3 live sessions.
  Make it controllable (on by default when LHC serving is enabled; a documented
  env to force off).
- Zero cost when `GROK_LHC` is unset — behind the same cheap gate as the rest
  of hook 4 (E2 established this pattern).
- Never change the served result. The instrument observes; it must not decide.
- Certification: tests proving each counter fires when it should and stays
  silent when it should — including a **tool-using** window (expect
  structural ≠ 0, informational = 0 if serving is faithful) and a **text-only**
  window (expect both 0). If informational divergence is non-zero on a
  text-only window, that is a real serving defect — **report it, do not fix it
  silently.**

### Scope note to record in MAPPING.md

Prune/mutation serving is **out of Phase 3 scope**. If a later phase adds it,
mutations route through the **same native replacement path** (the write-back
law) — **not** through a revived serving substitution.

## G2 [blocking] Capture the real write-back body and diff it against the fixtures

**Ruling:** the structural test limitation must not rest as an accepted
limitation. The four gate tests drive the adapter path
(`handle.replace_history(&body)`), not the real shell write-back, so they could
be green against a body the host never produces.

Requirement: **capture the real body the shell write-back delivers** — item
shapes, ordering, system prefix, `prompt_index` markers — from an **actual
compaction run**, and diff it against the adapter-simulated body the gate tests
use.

- **Preferred: a live harness in Chunk 2**, if feasible. A test that drives a
  real `ChatStateActor` through an actual Replace-mode compaction and captures
  exactly what `replace_conversation_for_compaction` receives, then compares it
  field-by-field with `writeback_fixture()`.
- **If not feasible in Chunk 2**, say so explicitly and with the reason, and
  register it as a **mandatory Chunk 3 live-cert checkpoint** — recorded where
  Chunk 3 will find it, not just in a commit message.
- **If the bodies differ: regenerate the gate fixtures from the real body and
  rerun the gate.** Report what differed. A difference here means the hard gate
  was measuring the wrong thing, which is a finding in its own right.

## G3 [blocking] Chunk 1 accepted limitation #1 gets the same treatment

FORK.md's "Accepted limitations" #1 — the hook-2/hook-3 session-id coupling,
verifiable only by inspection — is **scheduled for verification at the same
Chunk 3 checkpoint**, not left as a permanent blind spot.

Update FORK.md so that section reads as **scheduled verification** rather than
permanent acceptance: for each item, what will verify it, and at which
checkpoint. Limitation #2 (async guards catching panicking but not silent
blocks) is already marked still-open — fold it into the same schedule.

## G4 [minor] Ledger

- FORK.md's touchpoint table lists the `/btw` and memory-flush consumers at
  `session/recap.rs` and `session/memory_dream.rs`; the real paths are under
  `session/acp_session_impl/`. I have corrected this already — leave it.
- Re-verify every carve-out numstat against the tree after this round and
  update FORK.md in the same change if it moves.

---

## Report

Position against the full project (Phase 3 of 4, unit 17 of ~22). Cover: the
canonical projection you defined and exactly what it normalizes away; both
counters and the tests proving each fires and stays silent correctly; whether
the G2 live harness was feasible in Chunk 2 and, if not, precisely why and
where the Chunk 3 checkpoint is recorded; whether the real write-back body
matched the fixtures, and what changed if it did not; and the FORK.md schedule.
Flag anything that pushed you toward the vendored port, a new touchpoint, or a
change in serving/compaction behavior.
