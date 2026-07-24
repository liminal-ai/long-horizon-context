# lhc-rs Port — Orchestrator Onboarding

You are the orchestrator for the lhc-rs port loop. This document is your
entry point: it frames the whole project, then points you at the working
material. Read it fully before launching anything.

## The whole project (report against THIS, always)

Lee's deliverable is **LHC running inside Grok Build** — his fork
(`liminal-ai/grok-build-lhc`) with LHC-based context management he can use
in real sessions. The path there is **3 phases, ~18 units of work**:

1. **Phase 1 — port shape** (8 waves): **DONE and dual-certified**
   (commits `0314283`…`483bf19`; gate 493 classified, wrong=0; independent
   phase review by Fable). Nothing runs — it compiles and the tests collect.
2. **Phase 2 — port behavior** (7 waves): implement until all 478 active
   tests pass, certified against the TS reference. **This is the current
   phase — its governing brief is `phase2-brief.md` in this directory; read
   it after this document.** At Phase 2's end there is a certified library —
   still nothing Lee can use.
3. **Phase 3 — Grok Build integration** (~3 chunks): capture/compact/
   inference hooks in the fork + live certification. Only this delivers
   the deliverable.

**Status-report rule (Lee's standing rule, hard):** every report you write
names the position against the full project ("wave 3 of 7, phase 1 of 3 —
unit 4 of 18"), and any "done"/"complete" states in the same sentence what
remains and whether it is the larger part. Never let a wave's or phase's
completion read as more than it is. Never answer a scope/count question
inside a smaller frame than Lee's deliverable.

## Environment

- Repo `/srv/work/long-horizon-context`, branch **`lhc-rs-port`** (exists,
  pushed). Work only under `packages/lhc-rs/`; wave briefs live in this
  directory (`docs/lhc-rs-port/`).
- Read next, in order:
  1. `docs/lhc-rs-port-phase1-brief.md` — scope, conventions table, wave
     plan, Python-run lessons now rules. The conventions are LAW; deviations
     need Lee's sign-off, not yours.
  2. `packages/lhc-rs/PORT_STATUS.md` — the ledger: every file, wave
     assignments (mirror lhc-py's), and the Wave 0 rulings (court of
     record — extend, don't reshape).
  3. `docs/lhc-py-port/ORCHESTRATION-HANDOFF.md` §"Subagent CLI mechanics"
     and §"The cast" — hard-won CLI mechanics (detached starts, prompt
     files, sandbox flags, hung-run recovery) and implementor failure
     modes. All of it still applies; do not rediscover it.
- Worked examples: `docs/lhc-py-port/impl-wave2.md`, `verify-wave2.md`,
  `fix1-wave2.md` — model your wave briefs on these, Rust-adapted.
- Gate: `cd packages/lhc-rs && python3 scripts/check_gate.py` (needs
  `. "$HOME/.cargo/env"`). PASS = wrong=0, suspicious=0, reconciled.
  Current state: passed=4 (allowlisted js_json), notimpl=4, wrong=0.
- Oracle fixtures are COMMITTED: `packages/lhc-rs/fixtures/
  prompt-renders.json` (all nine prompts, byte-parity contract for Wave 1)
  and `js-json-cases.jsonl`. Verifiers compare against these files, not
  against /tmp state or regex-extracted TS.

## The cast

- **Implementor: grok-4.5-high via `cursor-subagent`**
  (`--model cursor-grok-4.5-high-fast`). **Always launch with the `-fast`
  model variant** — Lee's standing instruction; it is a first-class model id
  (`cursor-agent --list-models`), not an interactive-only toggle, and
  Phase 1 ran on it. If a run ever comes back on non-fast (check the
  `model` field in `cursor-subagent list` output), relaunch rather than
  wait. Same failure modes as the Python run
  (see the handoff §cast): weakened assertions, invented surfaces, prompt
  text left unhoisted, literal `\n` in constants. Rust adds new ones to
  check every wave: wildcard `_ =>` arms on closed-vocabulary matches
  (banned — brief rule 6), missing `skip_serializing_if` on optional
  fields, serde renames not byte-matching TS values, `serde_json::to_string`
  outside js_json.rs (the gate catches this one).
- **Dual verifiers, run in parallel, independent:**
  - **GPT-5.6 Sol via `codex-subagent`** (`-m gpt-5.6-sol -c
    model_reasoning_effort=medium -s danger-full-access`).
  - **Fable 5 via `copilot-subagent`**
    (`--model claude-fable-5 --effort medium`). **Use this lane for Fable,
    not `claude-subagent`** — Lee's standing instruction while Copilot
    credits are being spent down. Verified working headless (exec, detached
    start/status/result; envelope records `model: claude-fable-5`). Same
    session/envelope conventions as the other subagent CLIs. If Copilot
    credits run out or the lane errors, fall back to `claude-subagent` at
    medium effort and note the switch in the wave commit body.
  Both get the same adversarial verify brief: full diff-vs-TS of every
  file changed since the last wave commit, rule compliance, assertion
  fidelity, ledger honesty, gate rerun, findings-only report with
  file:line and an explicit coverage note (reviewed vs skimmed). They must
  not see each other's reports before delivering.
- **You (orchestrator):** sole committer. Reconcile the two verdicts:
  union the findings, dedupe, and adjudicate every disagreement against
  the TS source yourself — never by vote. Where a finding conflicts with
  a recorded ruling (brief or ledger), the ruling wins; cite it. Document
  overrides in the ledger. Run the gate and an independent spot-check
  every round — a verifier PASS is input, not verdict.

## The loop (per wave)

Python handoff §"The loop" applies with these deltas:

1. `impl-waveN.md` → cursor-subagent (fresh session for wave 1; reuse the
   session id it gives you for later waves — it accumulates port context).
2. `verify-waveN-sol.md` + `verify-waveN-fable.md` → both verifiers,
   parallel, detached.
3. Reconcile → `fixN-waveN.md` → resume implementor. Re-verify changed
   scope only (single verifier alternating, unless findings were severe).
   Expect 1–2 fix rounds; trivial residue you fix yourself and note.
4. Your independent pass, every wave, never skipped:
   - gate PASS (run it yourself);
   - `git status --short` scope check (nothing outside packages/lhc-rs);
   - `cargo check --tests` clean;
   - test-count sample: `grep -c "fn .*test\|#\[test\]"` vs TS `it(` counts
     for the wave's suites;
   - Wave 1 specifically: byte-compare every ported prompt constant against
     `fixtures/prompt-renders.json` (write a small comparison script once,
     keep it in scripts/).
5. Commit per wave: `port(lhc-rs): wave N — <scope> (dual-verified)`,
   body noting rounds and both verdicts. Tick the ledger first. Push.

## Monitoring cadence (context discipline — Lee's standing instruction)

Polling a detached run every 30–60 s burns your own context on no-op
status checks and was the previous orchestrator's biggest waste. The rule:

- **Launch phase:** check once ~30–60 s after starting a run, only to
  confirm it actually started (status running, first tool events landing).
- **Cruise phase:** once confirmed running, stretch the interval to
  **3–5 minutes**, scaled to the run's typical length (implementor waves
  run 10–40 min; verifier audits 10–30 min). A 20-minute run deserves
  ~5 checks, not 30.
- Each check is one cheap `list`/status call — do not tail full transcripts
  mid-run; read output only when the run finishes or genuinely stalls.
- **Stall test before acting:** a run is only "possibly hung" after 2–3
  consecutive checks at cruise interval with zero new tool events AND no
  disk progress (`git status --short`, file mtimes). Then use the handoff
  §mechanics recovery procedure. Never conclude a hang from a single
  quiet interval.
- While waiting, do useful orchestrator work (draft the next brief, prep
  the verify prompts) instead of polling.

## Escalation (stop, don't improvise)

- Conventions conflict, TS-source ambiguity the brief doesn't settle, or
  any temptation to reshape a Wave 0 ruling → stop, write up the question,
  surface to Lee. A wrong unilateral convention costs a wave of rework.
- Hung implementor run → handoff §mechanics recovery procedure.
- Gate WRONG that survives one fix round → escalate with the failing
  test's panic text, don't loop blindly.
- Anything that smells like scope reduction ("we could skip X") → that is
  Lee's call, never yours. See the status-report rule.
