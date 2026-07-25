# Phase 4 / Chunk 2 — confirmation of YOUR prior findings (resumed session)

You are resuming your own Chunk 2 verification session. You already audited
this bridge and filed findings; this round is **narrow**.

**Do not re-audit the chunk.** Do not run a fresh maximal search. Check your
own prior findings against the changed scope, and flag regressions in the
changed files only.

## What happened since your report

Your findings were reconciled with the other lane's (independently, separate
trees) and the bridge was **rebuilt, not patched** — the orchestrator judged
the mechanism wrong rather than buggy. Brief: `phase4-redo-chunk2b.md`
(this directory), items R1–R9.

Headline changes:

- **R1** — `render_served_body` and `RENDER_SEAM_ID` are **deleted**. The
  served body now comes from `thread_view.compact()` → `CompactReceipt`, then
  `get_llm_request_context()` → `llm_request_context_to_response_items`.
  The seam is now a mapping (`VIEW_MAP_SEAM_ID`), not a summariser.
- **R2** — `lhc_inference_callbacks(true)` now returns
  `LhcInferenceError::LiveNotConfigured` (fail closed); a real `ModelClient`
  bridge exists in `lhc_inference_bridge.rs`, gated by
  `CODEX_LHC_LIVE_INFERENCE=1`.
- **R3** — `host_history_coverage_gap` + `import_host_items_into_archive`:
  import inherited history, or refuse to compact a partial archive.
- **R4** — law 1 is structural equality including `phase` and content
  variants; law 2 asserts the next-turn property through
  `context_window_token_status`.
- **R5** — both production ladders are now entered by tests
  (`production_manual_ladder_invokes_lhc_arm`,
  `production_auto_ladder_invokes_lhc_arm`), proof being the LHC marker.
- **R6** — marker built from the real receipt, committed **after**
  write-back, keyed `{covered_from}:{compact_point}` rather than `view_id`.
- **R7** — timeouts (120s produce / 30s marker), cancellation flag, panics
  surfaced.
- **R8** — token bound applied after initial-context injection;
  `InitialContextInjection: Clone` sentinel-marked and patched; patch 0007
  now carries 8 files; clippy added to the tripwire.
- **R9** — shape-risk consumer goldens added.

Sentinels 35. Tripwire reported green by the implementor (the orchestrator
re-runs it independently).

## Your task

1. **For each finding you filed**: resolved, partially resolved, or not
   resolved? One line each. Where you claim resolved, say what you ran.
2. **Regressions only, in changed files.** The rebuild is large; a fix that
   introduces a new defect in the changed scope is in scope. A pre-existing
   issue elsewhere that you did not previously flag is **not** — note it in
   one line at the end if you must, but do not treat it as blocking.
3. **Mutation-test the claims that matter**: R1 (body genuinely from LHC's
   compact, not reconstructed host-side), R4 (both law tests fail when the
   invariant breaks), R5 (each ladder test fails when its hook is removed),
   R6 (retry writes exactly one marker; nothing written on cancellation or
   fallback). Paste real output.

## The orchestrator's acceptance bar — calibrate to it

Chunk 2 is accepted when: the body is produced by LHC's own compaction; law 1
holds as equality on a non-trivial body; law 2 holds as the next-turn
property; both ladders are covered by hook-removal-sensitive tests;
resume/fork import or refuse; the inference gate fails closed; fail-open is
bounded against the context window; tripwire green on a clean rebuild with
patches applying to a clean checkout.

**Not blocking, and not grounds for another round:** documentation wording,
naming, inventory/table rows, module length, change-set size, warnings, or
test-metadata observations. Report them in a single trailing list if you
find them; do not rank them as findings. "Blocking" means the product is
wrong.

If you believe the component is functionally sound, **say so plainly** —
that is a useful and expected outcome, not a failure to find something.

## Rules

Your own tree; mutate freely, restore exactly, confirm the tree matches its
pre-check state. Do not commit or push. You still never see the other lane's
report.

## Report

Short. Structure: (1) your prior findings, one line each with status;
(2) regressions in changed scope, if any, with `file:line` + failure
scenario + severity; (3) mutation outputs; (4) a plain verdict on whether the
bridge is functionally sound; (5) trailing non-blocking observations;
(6) coverage note.

---

## Seed context — YOUR prior findings (session lost; this replaces resume)

Your Chunk 2 session was launched in an isolated tree that has since been
removed, so `--resume` could not find it. Per the onboarding doc's
§"Verifier session continuity", the break is noted in the round log and you
are seeded with your **prior findings list** (titles only, deliberately not
report prose — re-derive detail from the code if you need it).

You previously filed, against the ORIGINAL 2b build (now rebuilt):

1. `band_shape.rs:69-75` — render seam fabricates a conversation when no event carries text; the arm installs it as user history
2. `band_shape.rs:84-92` — with ≤2 user turns the whole transcript becomes the "full" band; the compact reduces nothing and law 2 fails
3. `compact_lhc.rs:107-120` — `MAX_BODY_ITEMS = 512` bounds item count, not size
4. `compact_lhc_tests.rs:218-228` — law-2 test cannot fail for the reason law 2 exists
5. `compact_lhc.rs:151-161` — law-1 check runs AFTER install and returns `Err`, so a mismatch destroys history and aborts the turn with no fail-open
6. `compact_lhc.rs:218-236` — law-1 fingerprint breaks on any non-`Message` item
7. `patches/lhc/0007` — omits the arm; history-reset drill yields a non-compiling tree
8. `compact_bridge.rs:202-206` — each compact's marker re-enters the next served body, growing it forever
9. Brief item 5 — five of six shape-risk goldens absent; the sixth bypasses the production path
10. `check-lhc-hooks.sh:118-131` — capture→rebuild tripwire layer not done, but FORK.md claimed it was
11. Constant-against-itself — two occurrences
12. Vacuous assertions in both law tests
13. `inference.rs:18-22` — `ModelClient` bridge not delivered; gate flag a silent no-op
14. `compact_bridge.rs:72-85` — `CompactReceipt` describes LHC's internal view, not the served body
15. `compact_bridge.rs:244-261` — one-marker-per-compact not robust under retry
16. `compact_lhc.rs:177-205` — `!Send` thread: no timeout, leaks a marker write on cancellation, swallows panics
17. `core/src/compact.rs` — unmarked, uninventoried `#[derive(Clone)]`
18. `FORK.md:71` — stale
19. Warnings introduced

**Note #8 especially** — "the marker re-enters the next served body, growing
it forever" is a compounding defect and the redo changed both the marker and
the body path. Verify it is genuinely gone, not relocated.

Several of these (1, 2, 6) were about `band_shape.rs` / the render seam,
which no longer exists — confirm the concern did not survive the move into
`llm_request_context_to_response_items`.

Work the same structure the brief above specifies: status per prior finding,
regressions in changed scope only, mutation output, plain verdict.
