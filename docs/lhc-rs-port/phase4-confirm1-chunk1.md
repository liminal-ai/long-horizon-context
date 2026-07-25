# Phase 4 / Chunk 1 — confirmation pass (changed scope)

You are one of **two independent** confirmers. You will not see the other's
report. **Findings only.** Do not re-audit what did not change; do not pad.

## Position

**Chunk 1 = unit 20 of 22** — capture only. Chunks 2–3 remain and are the
larger part. Phase 4 = units 19–22 of a 22-unit project.

## Subject

`/srv/work/codex`, branch `lhc`, uncommitted working tree. Two fix rounds
have landed since the audit you (or your counterpart) performed. Review
`git diff be96ada3de` plus untracked files, but **concentrate on what the
fixes changed** — the redesigns are where new defects hide.

Briefs: `phase4-fix1-chunk1.md` and `phase4-fix2-chunk1.md` in
`/srv/work/long-horizon-context/docs/lhc-rs-port/` list every finding and
what was claimed as its fix. `/srv/work/codex/FORK.md` laws remain binding.

## What changed, and what to attack

1. **Idempotency was redesigned** (F1/F2). Keys are now `ResponseItemId`-
   primary: `codex:{tid}:id:{item_id}:{kind}[:part]`, with the occurrence
   high-water path retained only for anonymous (id-less) items. Attack:
   - Are `ResponseItemId`s actually stable across restart/replay in this
     host, or does core mint fresh ids on replay? Verify against core, not
     the adapter's assumption — the whole fix rests on this.
   - Items with **no** id still use occurrence counters. Is that path still
     correct, and is it reachable in production? Which real items lack ids?
   - Does the part-suffix scheme make multi-event items (e.g.
     `ImageGenerationCall` → 2 events) genuinely idempotent under a crash
     between the two submits?
2. **Typed provenance replaced the content classifier** (F6).
   `RawItemProvenance{UserPrompt, ModelOutput, HostContext, InterAgent}` is
   threaded through `record_conversation_items` / `send_raw_response_items`.
   Attack: is every call site tagged *correctly*? A mislabeled site is the
   same defect class as before, just typed. Confirm `BOOTSTRAP_PREFIXES`
   and `runtime_note_text` are gone, with no content sniffing anywhere.
   Check the `default HostContext` fallback — what actually lands there?
3. **Queue-full policy changed** (F5): `degraded` latch + refuse, replacing
   silent drop. Attack: can the latch be set spuriously? Once latched, is
   recovery possible, and is the degraded state observable to the user or
   only to logs? Is a partially-captured thread now worse than a lossy one
   for Chunk 2's write-back?
4. **Thread open moved off the critical path** (F17): `on_thread_start` now
   schedules open on a background thread; early raw items before open
   completes are **dropped with a warn**. Attack: how wide is that window in
   practice? Is the very first user prompt of a session at risk? That would
   be a silent, systematic hole in exactly the events that matter most.
5. **`catch_unwind` around contributor futures** (F16). Attack: is it
   sound (`AssertUnwindSafe` over a future touching shared state), and can a
   panic leave the capture worker's state inconsistent rather than merely
   logged?
6. **`model_change` / `thinking_level_change` via `ConfigContributor`**
   (F15/G1). Attack: does `emit_config_changed_contributors`
   (`core/src/session/mod.rs:1720`) actually fire on the paths claimed? Is
   the sync callback doing anything that can block? Are ordinals stable
   across restart?
7. **Media and arguments now carried in `extra`** (F7/F8):
   `argumentsRaw`/`inputRaw` verbatim strings, `extra.images`/`extra.audios`.
   Attack: does `extra` actually survive into the persisted LHC record, or
   is it dropped at the intake boundary? Verify by reading the stored row,
   not the mapper's output.
8. **Tripwire rewritten** (F3/F12): now compiles core/app-server/extension-
   api, fails on a dirty submodule, runs an e2e seam test. Attack: find what
   it still cannot catch. The orchestrator has already independently
   confirmed the e2e test fails when the hook body is deleted — do not
   re-do that; find the *next* gap.

## Standing requirements (unchanged, and the bar that caught round 1)

- **Vacuity**: for every test claimed as guarding a fix, break the
  production code and run it. Report actual output. Round 1 shipped an
  `assert_eq!(0u64, 0)` and a suite that passed with seeding deleted.
- **Fixture faithfulness**: goldens must be shapes the host can produce.
- Restore any mutation exactly; confirm the tree matches its pre-check state
  and say so. Do not commit or push.

## Report

Findings only, severest first: `file:line`, one-sentence defect, concrete
failure scenario, severity (BLOCKER/MAJOR/MINOR), CONFIRMED vs SUSPECTED.
Explicitly list any round-1 finding you believe is **not** actually fixed.
End with a coverage note: reviewed line-by-line vs skimmed vs not opened,
and which tests you executed.
