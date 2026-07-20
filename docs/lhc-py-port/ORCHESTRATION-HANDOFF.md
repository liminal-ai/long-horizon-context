# lhc-py port — orchestration handoff brief

**Audience:** a fresh agent session taking over orchestration of the lhc-py
Phase 1 port. Self-contained: you need no prior conversation context. Read
this fully, then take over the loop.

## Mission

Drive the Phase 1 port (module-for-module skeletons + tests, NO behavior) of
`packages/lhc` (TypeScript) to `packages/lhc-py` (Python) to completion, wave
by wave, using implementor/verifier subagents. Run until done or until you hit
a blocker that genuinely needs Lee — then ask, otherwise don't. Lee is busy;
your job is autonomous shepherded progress with visible status.

**The contract for all port work** is `docs/lhc-py-port-phase1-brief.md` (repo
root docs/). Every subagent gets pointed at it. Read it yourself first.

## Environment

- Repo `/srv/work/long-horizon-context`, branch `lhc-py-port` (exists; check it
  out if needed). Ledger: `packages/lhc-py/PORT_STATUS.md` — single source of
  truth for remaining work. Gate: `cd packages/lhc-py && uv run python
  scripts/check_gate.py` (must end GATE PASS / wrong=0 / collection clean).
- You are the ONLY committer. Subagents never commit/push; they work on the
  same checkout (sequential runs — never two implementors at once).
- Wave briefs and fixtures from the run so far live in `docs/lhc-py-port/`
  (this directory). TS-oracle prompt renders: `ts-prompt-renders.json`.
- Pending chore at next commit: `git rm -r --cached` the tracked
  `packages/lhc-py/**/__pycache__` files (committed in Wave 0 before
  .gitignore existed).

## State as of writing (2026-07-20 ~16:10 UTC) — verify against live sources

- Waves 0+1: committed (`cb75871`). Wave 2: implemented, gate green (162
  collected, wrong=0), Sol verification was in flight as codex run
  `20260720-160137-008c9a` — check `codex-subagent result 20260720-160137-008c9a`
  and act on its verdict.
- Remaining: Wave 3 (threads+intake), 4 (messages), 5 (turns+chunks),
  6 (thread-view — biggest), 7 (sdk surface + re-exports). Scopes are defined
  in the Phase 1 brief; model wave briefs on `impl-wave2.md` in this dir.
- On ANY re-entry: `cursor-subagent list -n 2` and `codex-subagent list -n 2`
  (from the repo dir) to see what finished while you were away, plus
  `git log --oneline -3` and `git status --short`.

## The cast (Lee's model calibration + today's observations)

- **Implementor: grok-4.5-high via `cursor-subagent`** (flag:
  `--model cursor-grok-4.5-high`). Fast (5–30 min/wave), honest reporter,
  BUT cuts corners under the hood. Observed failure modes — verify these
  EVERY wave: weakened/dropped assertions (especially vitest-skipped tests —
  they must be full bodies under `@pytest.mark.skip`), invented surfaces
  (e.g. `sdk.drain` for `sdk.work.drain`), broad-type reductions (`object`/
  `dict` where TS has closed unions), prompt text left inside skeletal
  renderers instead of hoisted verbatim constants, literal `\n` vs real
  newlines in constants.
  Reuse its cursor session — it holds full port context:
  `--resume 102e776f-62dc-4e4d-a57c-7ede2ebdafe8`.
- **Verifier: GPT-5.6 Sol via `codex-subagent`** (flags: `-m gpt-5.6-sol
  -c model_reasoning_effort=high -s danger-full-access`). Excellent, tenacious,
  byte-checks programmatically, honest coverage notes. Quirks: over-reaches
  scope (demands full ports of deliberately-partial stubs — apply the policy
  ruling below), and occasionally flags things already handled — cross-check
  findings before forwarding them wholesale.
- **Fable via `claude-subagent`**: reserve for tie-breaks and extra audits of
  the waves that matter most (Wave 6 thread-view especially).
- **You**: gate every round yourself, spot-check independently (don't just
  read reports), rule on scope disputes, commit.

## Subagent CLI mechanics (hard-won; do not rediscover)

- Onboarding text: run bare `cursor-subagent` / `codex-subagent` /
  `claude-subagent`. Envelope JSON at
  `~/.subagent-clis/<backend>/sessions/<run_id>/envelope.json`; also
  `status`, `result`, `last`, `messages`, `list`, `stop` subcommands.
- ALWAYS `start` (detached — survives your session restarting), never bare
  `exec` in background shells. Multi-line prompts via `--prompt-file <path>`.
- codex sandbox: bubblewrap is BROKEN on this box. Fresh codex runs need
  `-s danger-full-access`. `codex exec resume` (via `--resume`) REJECTS `-s`
  entirely — for verdict-only resumes omit it (fine if no tools needed).
- A hung cursor run: process alive but zero new events ≥5 min after a
  tool_result → `cursor-subagent stop <run_id>`, then `start` a resume prompt
  listing done-vs-remaining (see `git status` + ledger). Edits on disk and the
  cursor session survive; nothing is lost. This happened once today.
- Envelope `status:"ok"` ≠ correct work. Always run the gate yourself and
  spot-check the diff.

## The loop (per wave)

1. **Implement**: write `impl-waveN.md` (model on `impl-wave2.md` here —
   include scope from the Phase 1 brief, the do-not-repeat rules list, gate
   requirement, report format). `cursor-subagent start --prompt-file ...
   --model cursor-grok-4.5-high --resume 102e776f-...`.
2. **Verify**: write `verify-waveN.md` (model on `verify-wave2.md`) —
   adversarial, full diff-vs-TS comparison of every changed file since the
   last wave commit, rule compliance, test-assertion fidelity, ledger honesty,
   gate. `codex-subagent start --prompt-file ... -m gpt-5.6-sol -c
   model_reasoning_effort=high -s danger-full-access`.
3. **Fix rounds**: consolidate verifier findings + your own into `fixN.md`,
   resume the implementor. Re-verify (targeted confirmation pass, not full
   re-audit, once findings < ~5). Expect 1–2 fix rounds/wave (Wave 1 took 2).
   Trivial residue (a few type annotations): fix it yourself, note it in the
   next verify brief for confirmation — don't burn a 10-min loop on it.
4. **Your independent pass** (never skip): run the gate; `git status --short`
   scope check (nothing outside packages/lhc-py, no root-file touches);
   sample assertion counts (`grep -c "def test_"` vs `grep -c "  it("`);
   for prompt/constant-bearing waves, byte-verify against the TS oracle:
   `node --experimental-strip-types` imports `.ts` directly — render with
   sentinel inputs, compare to Python constants with `{{placeholders}}`
   substituted (existing fixtures: `ts-prompt-renders.json`). Regex-extracting
   TS literals is NOT a valid oracle.
5. **Commit** the wave: `port(lhc-py): wave N — <scope> (verified)` with a
   body noting rounds + verdicts. Tick gate column in ledger first.

**Policy rulings already made (keep consistent):**
- Out-of-order PARTIAL stubs (needed for collection) may stay partial but
  everything they contain must be faithful to TS — no inventions — and the
  ledger marks them ◐ with a note. Full port lands with their own wave.
- Sol's demands to fully port ◐ stubs early: decline, cite this ruling.
- Data keys verbatim camelCase vs snake_case identifiers: per the Phase 1
  brief; exemplars in the brief are canonical.

## Shepherding (Lee cares about this a lot)

- After starting any run: arm a heartbeat watcher AND a redundant re-entry.
  Heartbeat: poll `<cli> status <run_id>` every 60–90s for the first ~3
  checks, then every ~3 min; emit progress (event count delta); 2 consecutive
  no-progress checks = stall → diagnose (pid alive? last_event_ts? stderr?)
  → stop+resume. If your harness has Monitor, use it; also schedule a
  self-wakeup (~6 min) if available — session restarts kill watchers but not
  detached runs, and today that caused a silent hour. Never let silence
  accumulate: if Lee sees nothing for 10+ minutes, something is wrong with
  YOUR watch, not necessarily the run.
- Report to Lee in one or two lines at: wave start, verdicts, commits,
  anomalies. Plain language, no ceremony.

## Timing expectations (today's actuals)

Wave 1 impl 12.5m; Sol audits 4–14m; fix rounds 5–13m; Wave 2 impl ~40m
total across a hang + resume. Waves 3–5 similar to 2; Wave 6 likely the
longest (13 view test files); Wave 7 small. Sequential = slow and steady is
the accepted pace.

## Done means

Ledger 100% ticked (or EXCLUDED), gate GATE PASS with wrong=0, final commit
updates `packages/lhc-py/README.md` with summary counts + a Phase 2 handoff
note (per the Phase 1 brief's "Done means"). Then tell Lee it's done and
STOP — Phase 2 (implementation) is a separate, deliberate decision.
