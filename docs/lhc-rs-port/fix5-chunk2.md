# Chunk 2 fix round 5 — dedup ruling, hook-4 instrumentation, scheduled blind spots

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

H1–H6 are accepted. I verified independently: tripwire 6/6, 54 certification +
5 goldens, `clippy --all-targets` clean, fmt clean in both crates, and
`writeback_body_is_fixpoint_through_replace_history` is a genuine test — it
builds the second body *from the first* and compares synthetic-ness,
`prompt_index`, and text, so it fails if a second pass re-stamps.

**One correction to my own H1 spec, so it does not mislead later work:** my
requirement 2 said positional `User(_)` counting in `truncate_to_prompt_index`
must agree with `state.prompt_index` after write-back. **That requirement was
wrong.** The host documents at `rewind.rs:125-136` that *native* compaction has
the same property — "compaction collapses N+1 user messages into ~3", so
`truncate_to_prompt_index` "produces wrong results for ALL post-compaction
targets" — which is precisely why `needs_compaction_replay()` routes rewind
through `replay_to_prompt`. Your approach matches native, and H3's checkpoint
pairing is what makes that path correct. Keep it.

This round is the remaining ruled work. It changes no serving or compaction
behavior except where G1 explicitly adds observation.

---

## J1 [blocking] Dedup ruling — document and pin it

**Ruling (Fable phase-reviewer, relayed by Lee, after reading
`idempotency.rs`): the identical-content dedup is CORRECT BY DESIGN.** A
summary that serializes byte-identically to an already-recorded item is deduped
away, and that is the content-addressed contract working. The B1 key design
makes the record **content-complete** — a byte-identical summary adds no
information — and compaction *provenance* does not live in the event log.

Two of the three attached requirements are yours (the third is a verifier's):

1. **Document it in `MAPPING.md`** as a deliberate property, not an accident,
   and cite where compaction provenance actually lives. Verified references:

   | Provenance | Location |
   |---|---|
   | Compact receipts | `CompactReceipt` (`vendor/.../thread_view/mod.rs:1235-1250`) — `view_id`, `profile`, `config`, `bands` report, `tail_tokens`, `total_tokens`, `covered_from`, `compact_point`, `degraded` |
   | Derivation family | `query_derivation_log` → `Vec<StoredDerivationLogEntry>` (`vendor/.../sdk.rs:230`) |

   State plainly that "was this text produced by a compaction, and under what
   profile/config?" is answerable from the receipt and derivation log rather
   than from a duplicate event.

2. **Pin it with a narrow test.** A summary byte-identical to an
   already-recorded item must yield **no new event**, cause **no key-stream
   disturbance for subsequent items**, and leave the **occurrence walk
   aligned**. All three assertions, not just the first — the second and third
   are what prove the dedup is inert rather than merely silent.

Do **not** change the dedup behavior. This is documentation and a pin.

## J2 [blocking] Instrument hook 4 (the ruled G1, now that the body shape has settled)

**Ruling:** hook 4 is being removed *by evidence, not by argument*. It stays
through Chunk 2 certification, demoted to **instrumented-redundant**. Zero
divergence through Chunk 3 live cert → it comes out at Chunk 3 as a
touchpoint-set change. Any divergence → each instance is either a bug to fix or
the documented reason the hook stays, and **the first one goes to Lee**.

Add an equivalence assertion at hook 4: the served view and the natively-built
request body must be **identical between compacts**.

### Measure two signals separately — do not collapse them

A naive byte comparison diverges on **every tool-using session** for a known
structural reason (`LlmRequestContext` has no tool-call representation), which
would drown the real signal. There is also **no existing normalization to
reuse** — the golden diffs use `project(events)` over mapped events, a
different comparison. So you are defining this.

1. **`structural_divergence`** — raw comparison (item count, kinds, roles,
   byte-level text). Expected non-zero whenever the window contains tool calls.
   Log **once per session per class** with the shape of the difference, never
   per turn.
2. **`informational_divergence`** — comparison after a **canonical text
   projection applied identically to both sides**: each item reduced to
   `(role, canonical_text)`, native tool calls and results rendered into the
   same textual shape LHC uses, thinking handled identically, whitespace
   normalized. **This is the actionable signal.** Non-zero here is a finding.

Define the projection once, apply it to both sides, and document in MAPPING.md
exactly what it normalizes away — a reader must be able to judge what the
evidence covers. Do **not** normalize away ordering, item count, or message
content.

Log divergences with the **triggering state**: session id, turn index, whether
a compact has occurred, counts per side, and the first differing item with its
index.

Constraints:
- Armed in Chunk 2 certification and available for Chunk 3 live sessions;
  controllable, on by default when LHC serving is enabled.
- **Zero cost when `GROK_LHC` is unset** — behind the same cheap gate as the
  rest of hook 4 (the E2 pattern).
- The instrument **observes only**; it must never change the served result.
- Tests: each counter fires when it should and stays silent when it should,
  including a **tool-using** window (structural ≠ 0, informational = 0 if
  serving is faithful) and a **text-only** window (both 0). **If informational
  divergence is non-zero on a text-only window, that is a real serving defect —
  report it, do not silently fix it.**

Record in MAPPING.md: prune/mutation serving is **out of Phase 3 scope**; if a
later phase adds it, mutations route through the **native replacement path**
(the write-back law), never a revived serving substitution.

## J3 [major] Reframe the blind spots as scheduled verification (the ruled G3)

FORK.md's "Accepted limitations" must not read as permanent acceptance. Ruling:
each gets **scheduled verification** at a named checkpoint.

Rewrite that section so every item states **what will verify it** and **at
which checkpoint**:

1. **Hook-2/hook-3 session-id coupling** (verifiable only by inspection today)
   — scheduled for the same Chunk 3 live-cert checkpoint as the write-back body
   capture.
2. **Async guards catch panicking but not silent blocks** — already marked
   still-open; fold into the same schedule.
3. **The G2 live harness** — you deferred the full shell Replace harness to
   Chunk 3. Make sure it is recorded there as a **mandatory** checkpoint with
   what it must capture (item shapes, ordering, system prefix, `prompt_index`
   markers from an actual compaction run) and the rule that if it differs from
   the fixtures, the fixtures are regenerated from the real body and the gate
   re-runs.

## J4 [minor] Ledger

Re-verify every carve-out numstat against the tree after this round and update
FORK.md in the same change if it moved. Confirm the touchpoint inventory still
matches (sentinel 6/6) and that MAPPING.md matches the tree.

---

## Report

Position against the full project. For **J1–J4**: fixed / not fixed and why.
For J2, state the canonical projection you defined and **exactly what it
normalizes away**, plus the tests proving each counter fires and stays silent.
Confirm you did not change dedup behavior, serving results, or the capture tee.
Flag anything that pushed you toward the vendored port or a new touchpoint.
