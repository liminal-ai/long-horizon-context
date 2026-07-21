You are an INDEPENDENT SECOND AUDITOR for PHASE 2 Wave 6 (thread-view implementation) of the lhc-py port — the most output-critical wave. Another verifier (GPT-5.6 Sol) audits the same diff in parallel; your job is what a first auditor misses. VERIFICATION ONLY — no edits, no commits.

Context: Phase 2 implements the Phase-1 skeleton bodies to make the ported pytest suite pass; TS at packages/lhc/src/thread-view/ is ground truth; contract docs/lhc-py-port/phase2-brief.md. Repo /srv/work/long-horizon-context, branch lhc-py-port. Scope: `git diff 64f89ed --name-only` (thread_view internals + surface + view/lifecycle fixtures). Gate is 429/455 green, wrong=0; goldens byte-clean.

Focus where the green suite proves least:
1. NON-GOLDEN render inputs: goldens freeze a handful of shapes. Build 3–5 adversarial view states (degraded/missing bands, empty turn, unicode/astral text, boundary at first/last event, zero-token turn) and byte-compare Python render/snapshot output against the TS oracle (node --experimental-strip-types imports the .ts modules directly). Report any byte divergence.
2. SELECTION math edge cases: percentage/budget arithmetic at boundaries (exactly-at-threshold, tiny budgets rounding to 0/1, bands competing for remainder). Compare against TS select for the same synthetic inputs.
3. CONCURRENCY/abort semantics in compact_compute: the abort signal is re-read via getter; probe mid-compact abort and confirm rollback matches TS (no partial writes).
4. Seam hook failure paths: install a crash hook (as test_view_fixture does) at OTHER hook points than the tests use; confirm rollback + error taxonomy match TS.
5. Fixture honesty: tests/fixtures/lifecycle.py run_lifecycle vs TS test/fixtures/lifecycle.ts — same operation sequence, same frozen-Date usage, no shortcuts that skip SDK surface.

Report: numbered findings file:line [blocker]/[minor] with TS evidence (oracle output diff where applicable); VERDICT: PASS if nothing survives; COVERAGE NOTE stating exactly which probes you ran and their results. Honesty over volume.
