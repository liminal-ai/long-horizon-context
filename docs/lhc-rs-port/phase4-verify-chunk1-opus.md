# Phase 4 / Chunk 1 — adversarial verification (independent lane)

You are one of **two independent verifiers**. You will not see the other's
report, and it will not see yours. Do not soften findings in anticipation of
agreement, and do not pad with agreement to look thorough. **Findings only.**

## Position

Project = 22 units. Phases 1–2 (Rust port) DONE and dual-certified; Phase 3
(Grok Build) in progress; **Phase 4 = units 19–22**, Chunk 0 DONE, and the
work under review is **Chunk 1 = unit 20 of 22** — capture only. Chunks 2–3
remain and are the larger part.

## Subject

Repo `/srv/work/codex`, branch `lhc`. Review **everything changed since
`be96ada3de`** — i.e. `git diff be96ada3de` plus untracked files
(`git status --short`). Work is in the working tree, uncommitted.

## Read first (all of it, before reviewing)

1. `/srv/work/codex/FORK.md` — the eight laws and the touchpoint /
   tripwire / patch-series discipline. Binding.
2. `/srv/work/long-horizon-context/docs/lhc-rs-port/phase4-impl-chunk1.md`
   — the implementor's brief: seam facts, deliverables A–E, certification
   requirements. This is what the work is measured against.
3. `/srv/work/long-horizon-context/docs/lhc-rs-port/phase4-codex-integration-brief.md`
   — seam map and the "Laws from the Phase 3 Chunk 2 escalation" section.
4. The implementor's own report (the run's final message —
   `grok-subagent last 20260725-173623-cd8739`). Treat its claims as
   **claims to be checked**, especially the break-it-and-watch-it-fail
   evidence.

## What to attack (ranked by what has actually bitten this project)

1. **Vacuous tests (FORK.md law 3).** The single highest-yield attack. For
   every test guarding a hard invariant — idempotency under retry, ordering
   across resume, encrypted-payload passthrough, flag-off inertness, crash
   injection — ask: *would this fail if the production code were deleted?*
   Do not answer by argument. **Actually break the production code, run the
   test, and record what happened.** Three tests survived three rounds in
   Grok Build's Chunk 2 by being argued about rather than run. Report any
   test that passes against gutted production code as a CONFIRMED defect.
2. **Unfaithful fixtures (FORK.md law 4).** Goldens must be shapes the host
   can actually produce. A fixture hand-written to match the mapper rather
   than derived from a real host construction path tests nothing. Check
   provenance of every golden.
3. **Mapping fidelity.** All 17 `ResponseItem` variants
   (`codex-rs/protocol/src/models.rs:799`) accounted for, exhaustively
   matched, **no `_ =>` wildcard arm** on that closed vocabulary. Check
   specifically: `Reasoning.encrypted_content` passed through verbatim (not
   dropped, not re-encoded); `FunctionCall.arguments` preserved byte-exact
   as the raw wire string (not parsed-and-reserialized); no structured item
   flattened to prose (law 5); call/output correlation by `call_id` and
   never by content (law 6 — content-keyed classification is a recorded
   defect family, hit in two hosts).
4. **Idempotency.** Is the key genuinely stable across resume, replay,
   retry, and **process restart**? Are occurrence counters seeded from LHC's
   stored events rather than the host's in-memory slice? Construct the
   adversarial case: same item content, two legitimately distinct
   occurrences — do they collide? And: an item re-presented after restart —
   does it double-record? Note that `replace_compacted_history`
   (`core/src/session/mod.rs:3188`) does **not** route through
   `record_conversation_items`; verify that claim yourself and check whether
   the implementor relied on it correctly.
5. **Core touchpoint minimality and sentinel discipline.** Is every core
   line marked `LHC-HOOK`? Does `EXPECTED_HOOKS` in
   `scripts/check-lhc-hooks.sh` equal the real count? Does the FORK.md
   inventory table match the code? Is the `patches/` series regenerated and
   distinct from upstream's third-party `patches/`? Is any
   `ext/extension-api` change genuinely **additive** (no existing trait,
   struct, or signature changed shape)? Is any LHC *logic* living in
   `codex-rs/core` rather than the adapter?
6. **Blast radius / safety.** Can capture block, slow, or panic into the
   session path? Is the queue bounded and are drops loud and observable?
   Is the flag-off path truly inert (no code executes) rather than
   "runs and discards"? Does `.await` inside the hook risk deadlock against
   the `state` mutex held in `record_conversation_items`?
7. **Gate honesty (law 3 corollary).** Run `./scripts/check-lhc-hooks.sh`
   yourself. Then check what it *actually* executes versus what its header
   claims — Grok Build's tripwire reported green over a red unit suite for
   two rounds because nothing ran `--lib`. Is layer 3 (golden smoke) armed,
   as this chunk required, or still skipping?
8. **Report honesty.** Any claim in the implementor's report that the code
   does not support is itself a finding. Check the mapping table against the
   code, and the test-failure evidence against reality.

## Rules

- Verify by **running things**, not by reading alone. You have
  `danger-full-access`; use it. Building and running tests is expected.
- If you modify the working tree to test a hypothesis (breaking code to
  check a test), **restore it exactly** — `git stash` / `git checkout --` /
  restore untracked files — and confirm the tree is back to its pre-check
  state at the end of your run. Say so explicitly in your report. Do not
  commit, do not push.
- Where a finding conflicts with a recorded ruling in FORK.md or the Phase 4
  brief, the ruling wins — cite it and move on.

## Report format

Findings only, most severe first. Per finding: `file:line`, one-sentence
defect, a **concrete failure scenario** (inputs/state → wrong outcome), and
severity (BLOCKER / MAJOR / MINOR). Separate CONFIRMED (you reproduced it)
from SUSPECTED (you reason it but did not reproduce).

End with an explicit **coverage note**: which files you reviewed line by
line, which you skimmed, which you did not open, and which tests you
actually executed. A verifier that skimmed and says nothing about it is
worse than one that skimmed and says so.

## Orchestrator addendum — specific items to assess

Reported by the implementor; assess each on the evidence, and do not assume
the implementor's framing is right:

1. **The vendored submodule working tree is dirty** — the implementor bumped
   `rusqlite` 0.37 → 0.39 inside
   `codex-rs/lhc/vendor/long-horizon-context` to unify `libsqlite3-sys` with
   codex-rs. The vendored port is **certified and pinned**; FORK.md's policy
   is "certified `lhc-rs-port` commits only". Determine: (a) is the version
   conflict real — verify it, do not take it on faith; (b) is 0.39 actually
   required, or is there a resolution that leaves the pin clean; (c) does the
   bump change any behavior the port was certified on (rusqlite 0.37→0.39 API
   and SQLite semantics — transaction behavior, error types, bundled SQLite
   version), or is it packaging-only as claimed. Cite specifics.
2. **`FunctionCall.arguments` fidelity.** The implementor parses the raw wire
   string into a Map because LHC intake requires an object, wrapping
   non-object JSON under `"raw"`. The impl brief required byte-exact
   preservation. Assess whether round-tripping is genuinely lossless
   (key order, number spelling, duplicate keys, unicode escapes, whitespace)
   and whether the digest genuinely covers the original string.
3. **19 hooks landed against ~4 anticipated.** Assess whether every marker is
   a real touchpoint or whether the count is inflated by marking re-exports
   and struct fields; and separately whether any *unmarked* core line changed.
4. **`Message` role-based classification.** The implementor routes user
   messages to `user_prompt` vs `runtime_note` by detecting bootstrap content
   (AGENTS.md / `<user_instructions>` / env context). FORK.md law 6 bans
   classifying on content. Assess whether this classifier is content-keyed
   and therefore unsound by construction.
