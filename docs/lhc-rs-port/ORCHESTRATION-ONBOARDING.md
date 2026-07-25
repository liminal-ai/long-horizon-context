# lhc-rs Port — Orchestrator Onboarding

You are the orchestrator for the LHC-in-Grok-Build project. This document
is your entry point: it frames the whole project, then points you at the
working material. Read it fully before launching anything.

> **Phase 3 orchestrator? Start here.** Phases 1-2 (the port) are DONE and
> accepted — you are integrating, not porting. Read in order:
> `phase3-grok-build-integration-brief.md` (this directory — mission,
> chunks, host seam map, host obligations), then `/srv/work/grok-build`'s
> **FORK.md** (fork discipline: touchpoint inventory, patch series, sync
> drill, tripwires — Chunk 0 built this; every rule in it is binding).
> Your working repo is **`/srv/work/grok-build`, branch `lhc`** (origin
> `liminal-ai/grok-build-lhc`); the port repo stays read-only for you
> except submodule-pin bumps. The §cast, §monitoring cadence, and
> §escalation below still govern, with the Phase 3 deltas noted inline.

## The whole project (report against THIS, always)

Lee's deliverable is **LHC running inside Grok Build** — his fork
(`liminal-ai/grok-build-lhc`) with LHC-based context management he can use
in real sessions. The path there is **3 phases, ~18 units of work**:

1. **Phase 1 — port shape** (8 waves): **DONE and dual-certified**
   (commits `0314283`…`483bf19`; gate 493 classified, wrong=0; independent
   phase review by Fable). Nothing runs — it compiles and the tests collect.
2. **Phase 2 — port behavior** (7 waves): **DONE and ACCEPTED** at
   **481 active / 15 ignored / 496 total**, with all seven waves
   dual-certified and independent whole-phase Sol/Fable acceptance over
   `12830b3..1129bd8`. This produces the certified host-agnostic library,
   but still nothing Lee can use directly.
3. **Phase 3 — Grok Build integration** (~3 chunks + fork scaffolding):
   **IN PROGRESS — Chunk 0 (fork discipline) DONE** (fork `f99b4fb`:
   vendored submodule pinned to the certified port, adapter crate skeleton,
   tripwire script, FORK.md runbook). Chunks 1-3 (capture; inference +
   compact bridge; live certification) remain. Only Chunk 3's sign-off
   delivers the user-facing result.

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
  Accepted Phase 2 state: classified=496, passed=481, ignored=15,
  notimpl=0, wrong=0, suspicious=0; the transitional allowlist is absent.
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

### Phase 3 deltas to the loop

The per-wave loop above becomes per-chunk, same cast and dual-verify shape.
Additional Phase 3 mechanics:

- **Fork commits:** `fork(lhc): <scope>` on branch `lhc`; push to origin
  (the fork), never upstream. Any commit that adds or changes an
  `LHC-HOOK` line must, in the SAME commit: update the sentinel total in
  `scripts/check-lhc-hooks.sh`, update FORK.md's touchpoint inventory,
  and regenerate the `patches/` series (FORK.md documents how).
- **Tripwires replace the gate as your per-round independent check** in
  the fork: run `scripts/check-lhc-hooks.sh` yourself every round. The
  port-repo gate is only re-run when you bump the submodule pin.
- **Adapter crate is standalone** until patch 0001 lands (Chunk 1):
  `cargo check/test --manifest-path crates/lhc/grok-lhc-host/Cargo.toml`.
- **Submodule pin bumps:** only to commits of `lhc-rs-port` that pass the
  port gate; record old→new pin in FORK.md and the commit body.
- **Upstream syncs mid-phase:** upstream moves daily; if a sync is needed
  mid-chunk, run FORK.md's sync drill exactly — it is not improvised.
- **Host code reading:** the brief's seam map is symbol-level and from a
  2026-07-24 audit; re-verify each seam at the current tip before
  building on it, and treat a vanished seam as an escalation discovery.

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

## Escalation — REWRITTEN 2026-07-24, supersedes the prior rule

**Why this changed.** The prior rule said frozen shapes were never yours to
amend, so every forced amendment became a human stop. Across the first four
escalations of Phase 2, the phase reviewer approved 4 of 4 — in three of
them the evidence you already held uniquely determined the answer, so the
stop bought confirmation, not judgment. Meanwhile each stop blocks a run
designed to go unattended for 10+ hours, and Lee may not see it for hours.
The corrected balance: **a wrong self-authorized amendment costs one wave of
rework, caught by two verifiers, the gate, and the phase review, on a
revertible commit on a branch. A stop costs however long until Lee looks.**
Optimize accordingly — you have more authority than before, and a
correspondingly harder duty to document.

### Decide and proceed (do NOT stop) when ALL of these hold

1. The TS source, or a reproducible runtime probe you can cite, **uniquely
   determines** the answer — there is one faithful option, not a preference
   between defensible ones.
2. The change stays inside the project-owned surface and does not touch
   the certification target, wave plan, scope, or deliverable. For the
   port loop that means `packages/lhc-rs/`; **for Phase 3 it means
   `crates/lhc/` in the fork plus the core hooks already enumerated in
   the chunk you are executing.** A NEW core touchpoint beyond the
   chunk's enumerated hooks, or any change to the certified lhc-rs
   crate's semantics to fit the host, is never decide-and-proceed —
   that is stop line 2.
3. **Both verifiers agree** the change is forced (not merely acceptable).
4. You record it, in the same round: an entry in `PORT_STATUS.md`'s
   phase-gate addendum (what changed, the TS citation or probe output, why
   it was forced, which prior ruling if any it supersedes), and a line in
   the wave commit body naming the amendment.

This explicitly covers: frozen Phase 1 public shapes, private type
representations, adapter-seam signatures, and superseding a prior ruling
whose **factual premise** turned out wrong (e.g. a runtime behavior claim
disproved by probing). Undefined behavior or a memory-safety hazard is
never an acceptable way to satisfy a frozen shape — the shape is the
defect; amend it and say so loudly.

### Stop and surface to Lee when ANY of these hold

1. **The certification arithmetic or done-definition moves** — total test
   count, active/ignored split, pass target, or what "certified" means.
   This is the denominator Lee measures the project by; an orchestrator
   that adjusts its own finish line cannot be trusted to report against it.
   Rare, cheap, non-negotiable.
2. **Scope, deliverable, or plan moves** — anything resembling "we could
   skip X", "this needs another wave", "X should be deferred to Phase 3".
   See the status-report rule.
3. **Genuine ambiguity with divergent consequences** — TS is unclear or
   silent AND two defensible options would behave differently. If you find
   yourself weighing tradeoffs rather than reading a spec, that is Lee's
   call. (If you can cite the answer, it is not this case.)
4. **Superseding a ruling that was a judgment call**, not a factual error.
5. **A gate WRONG that survives one fix round** → escalate with the failing
   test's panic text; do not loop blindly.

### Persisted-bytes rule (the one class worth real ceremony)

Any amendment that can change **what gets written to SQLite or serialized
to JSON** — payload shapes, key order, number spelling, serde renames,
digest inputs — carries a mandatory extra step, because tests routinely
pass while bytes diverge, and this is the class that is expensive to
discover after the port is done (the Python run shipped a JSON-number
divergence this way):

- Commit a node-generated oracle fixture covering the changed shape
  (pattern: `scripts/gen-js-json-fixtures.mjs` → `fixtures/*.jsonl`).
- Add a conformance test against that fixture, and run it **at that wave's
  gate** — not deferred to phase end.
- Note the fixture by name in the wave commit body.

Proceed under the decide-and-proceed rule above; the oracle is what makes
proceeding safe.

### Other stops

- Hung implementor run → handoff §mechanics recovery procedure (this is a
  recovery procedure, not an escalation; do not wait on Lee for it).

### How to stop, if you must

Batch it. If two or three rulings are pending, deliver them in one
interrupt with recommendations, not one turn each. State the position
against the full project, what is blocked, what is NOT blocked (keep
working on anything independent while waiting), and your recommendation
per item.
