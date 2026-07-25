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

Lee's deliverable is **LHC running inside his agent CLIs** — first Grok
Build (`liminal-ai/grok-build-lhc`), then Codex (`liminal-ai/codex-lhc`),
with LHC-based context management he can use in real sessions. The frame
is **4 phases, ~22 units of work** (Phase 4 added 2026-07-25 by Lee):

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
4. **Phase 4 — Codex integration** (~4 units, 19–22): **PLANNED, NOT
   STARTED — do not begin without Lee's explicit kickoff.** Brief:
   `phase4-codex-integration-brief.md` (seams verified 2026-07-25; fork
   `liminal-ai/codex-lhc` exists, remotes wired at `/srv/work/codex`).
   Everything in this document governs Phase 4 the same way it governs
   Phase 3, with the fork surface being `codex-rs/lhc/` + enumerated
   hooks.

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
  - **Opus 5 via `claude-subagent`**
    (`--model claude-opus-5 --effort high`) — Lee's ruling 2026-07-25,
    REPLACING the prior Fable-via-copilot lane. Verified working headless
    (exec + effort flag; envelope records `model: claude-opus-5`). Same
    session/envelope conventions as the other subagent CLIs. The prior
    copilot-subagent/claude-fable-5 lane is retired; do not use it.
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
2. `verify-waveN-sol.md` + `verify-waveN-opus.md` → both verifiers,
   (existing `*-fable.md` files are the historical Phase 1-2 runs),
   parallel, detached.
3. Reconcile → `fixN-waveN.md` → resume implementor. Re-verify changed
   scope only (single verifier alternating, unless findings were severe).
   Expect 1–2 fix rounds; trivial residue you fix yourself and note.

### Verifier session continuity — MANDATORY (added 2026-07-25, Lee's ruling)

**Within a chunk/wave, re-verification RESUMES the same verifier
sessions** (`--resume <session_id>` from the prior envelope — every
subagent CLI supports it). A fresh verifier each round re-derives the
whole chunk from zero and arrives with a fresh set of priorities to
flag; the loop then chases convergence against a moving target. Chunk 2
of Phase 3 burned ~16 fix rounds this way — the single largest source
of round churn in the project.

- **Fresh sessions:** only at the FIRST full verification of a new
  chunk/wave (fresh eyes on new scope).
- **Resumed sessions:** every subsequent fix-round re-verification in
  that chunk. Give it the changed scope and let it decide what to
  examine. **Do not narrow it** — no "only look at your prior findings",
  no "changed files only". Continuity is what produces convergence: a
  verifier that remembers what it already checked and accepted will
  steer there by itself. Constraining its scope does not speed that up,
  it just caps the quality of the audit. The verifiers are as capable as
  the orchestrator; brief them on what changed, not on what to think.
- Independence between the two lanes is unchanged: each lane resumes
  its OWN session and still never sees the other's reports.
- Track the two session ids in the chunk record next to the round log.
- If a resumed session errors or its CLI loses it, note the break in
  the round log and start the replacement fresh with the prior round's
  findings-list (not report prose) as seed context.
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

## Verifier isolation — MANDATORY (added 2026-07-25, Chunk 2)

**Never launch two verifiers with the same working directory.** Use
`scripts/verify-isolated.sh <lane> <brief> <sol|opus>`, which rsyncs the fork
tree to `/srv/work/grok-verif-<lane>` and launches the verifier there.

**Why.** Through Chunk 2 both lanes were launched with cwd `/srv/work/grok-build`
— one tree, concurrently. Verifier mandates now include mutation testing (break
the code, watch it fail, restore), so two verifiers were editing and reverting
the same files at the same time. A verifier observed `equivalence.rs` change
under it mid-run (961 → 1160 lines → 961) and identified the cause as the other
lane's add-run-revert cycle.

Three consequences, all real:

1. **Unattributable measurements.** Any suite run overlapping the other lane's
   edits may have measured a tree neither verifier intended. Discard and re-run.
2. **Independence is unenforceable at the filesystem level.** One verifier read
   the other's test names and bodies off disk before writing its own. When that
   happens, agreement between lanes is **corroboration, not two independent
   samples** — and independent sampling is the whole reason for dual verify.
3. **Destructive restores.** A verifier restoring its own backup can silently
   delete the other's in-flight work, or resurrect work the other deleted.

**Assume this affected every dual-verify round in Chunk 2.** The findings
themselves were traced to source and the important ones were independently
re-derived by the orchestrator, so the substance largely stands — but no Chunk 2
round may be described as having produced *independent* agreement. Say
"corroborated", not "independently confirmed", for those rounds.

Corollary: never run the implementor concurrently with a verifier either, for
the same reason. If a verifier reports the tree changing under it, treat that
report as authoritative and re-run in isolation.

## Verifier session continuity — see §The loop

**The policy lives in "Verifier session continuity" under §The loop (Lee's
ruling).** Fresh sessions only at the FIRST full verification of a new
chunk/wave; resumed for every subsequent fix-round in that chunk. Do not carry
a previous chunk's session across a chunk boundary — new scope gets fresh eyes.

Recorded here only because it is the single largest source of round churn in
the project, and the reason is worth keeping next to the isolation rules:

**Why Chunk 2 took 17 rounds.** Every verifier run in Chunk 2 was a fresh
`start`. A fresh adversarial verifier does not know it is round 17 — it sees
the codebase for the first time, assumes first contact, and runs a maximal
search. Sixteen rounds of convergence are invisible to it, so it always finds
*something* new. Combined with an orchestrator stopping rule of "dispatch until
both verifiers PASS", the loop had **no fixed point**.

Carrying a "Settled — flagging these is a false positive" list in the brief is
**not** a substitute. It worked (no verifier re-litigated write-back, dedup, or
the ratified design) but it only suppresses re-raising *closed* items. It does
nothing about the incentive to open new ones.

**Orthogonal to isolation:** resume the session, isolate the filesystem. Both
apply.

**Corollary for the orchestrator's own stopping rule.** Before dispatching a
round, state what would make you stop. If the last two rounds produced only
documentation or test-metadata findings on a component both verifiers agree is
functionally sound, that is a stop — accept, and carry residuals as named
checkpoints. "Blocking" means the product is wrong, not that a table row is
mislabeled. In Chunk 2 the orchestrator let every CHANGES REQUIRED continue the
loop while never letting a PASS end it.

## Monitor protocol — MANDATORY (rewritten 2026-07-25 after getting it wrong twice)

**The monitor is a PERIODIC TIMER, never a condition-waiter.**

```
Monitor(command="sleep 240")        # correct: a timer
```

not

```
Monitor(command="while true; do ...check...; done")   # WRONG
```

**Why this is the whole protocol.** A condition-waiting loop only wakes you if
its condition fires. If the condition logic is wrong, or the job dies in a way
the loop does not anticipate, **the loop never exits and you are never woken** —
and you sit idle indefinitely believing work is in flight. That is not a
hypothetical: a watcher here tested `! pgrep -f "rsync.*<dir>"`, which matched
the watcher's own command line, so the condition was unsatisfiable and ~15
minutes were lost in confident silence. Every "improvement" made afterwards —
failure detection, stall detection, sanity deadlines — was **logic inside the
broken pattern**, and none of it fixes the case where the loop itself hangs.

A timer has no condition to get wrong. It always returns. You always wake.

**The loop:**

1. Launch the detached run.
2. Immediately arm `Monitor(command="sleep N")`.
3. On wake: run one cheap `status` check yourself.
4. Job still running → re-arm the timer. Job finished or failed → handle it.

**Choosing N — Lee's exact instruction, follow it:**

| Phase | Interval |
|---|---|
| Immediately after kickoff | check **at once** — confirm it actually started |
| Early, until clearly moving | **60–90s** |
| Once it is clearly going | **3–5 min** |
| Long runs (20–30 min+) | may stretch to **6 min — that is the ceiling** |

Faster than 3 minutes once a run is going **wastes context**; that was the
original complaint and it still stands. Slower than ~6 minutes and a hang goes
unnoticed for too long.

**Why this is the job, not an optimisation.** Processes hang. Processes get
terminated without emitting anything you would notice. If you do not wake up on
a timer, you simply **stop** — and an orchestration meant to run 6–7 hours
unattended dies silently while you believe work is in flight. Babysitting the
run to completion IS the orchestrator's job. If Lee has to ask whether anything
is happening, you have already failed at it.

**Side benefit, and not a minor one:** each wake produces a visible status
check, so Lee can see the work is alive. A condition-waiter that is quietly
spinning is indistinguishable, from outside, from a hung process.

**Launch quirk:** `codex-subagent` can exit `status:"error"` with stderr
`Reading additional input from stdin...` unless launched under `setsid` with
`< /dev/null`; redirecting stdin alone is not enough. It has also failed 3/3 in
rsync copies while working from the canonical tree (cause unknown — the
submodule gitdir is relative and git works in the copy, so that is not it).
Workaround: give that lane the canonical tree and the other lane a copy; the
lanes stay in separate trees, which is the property that matters.

**Still true, and still not sufficient on their own:**

- Launch and monitor are ONE step — never "I will arm it next".
- `running:false` is NOT success; a crashed run reports it too. Read `result`
  and check for `"status":"error"`.
- Verifier lanes never share a working tree (see verifier isolation above).
