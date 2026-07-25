# Phase 4 / Chunk 2a — census + band-shape harness (build it, do not run it)

Resume the same session. Same rules: **do not commit, do not push.**

Position: **Chunk 2 = unit 21 of 22.** Chunk 1 (capture) is committed and
pushed (`86e9873220`). Chunk 2 delivers rebuild + the compact bridge; Chunk 3
(live certification, unit 22) still follows and only its sign-off gives Lee a
usable result.

This is the *pre-bridge* half of Chunk 2. **Do not build the compact bridge in
this round.** Two things gate it, and this round produces exactly them.

---

## A. The census (FORK.md law 3 — required at chunk start, not when one bites)

Enumerate **every** consumer that reads whole-conversation state outside the
request builder, and confirm each rides native host state. Write it to
`codex-rs/lhc/CHUNK2-CENSUS.md` in the fork.

Started already (verify these, then finish the list):

| Consumer | Site | Note |
|---|---|---|
| Resume | `InitialHistory::Resumed` (`thread_manager.rs:874,1122,1164`) | replays persisted rollout |
| Fork — full history | `SpawnAgentForkMode::FullHistory` (`tools/handlers/multi_agents_v2/spawn.rs:66,205`) | **highest risk**: a fork taken after an LHC compact inherits the LHC body |
| Fork — last N turns | same file, numeric `fork_turns` | turn-counted slice |
| Manual `/compact` | `tasks/compact.rs::run` | is the ladder itself |
| Auto-compact | `session/mod.rs:3672` | same replacement API |
| New / Cleared | `InitialHistory::{New,Cleared}` | no history |

**Not yet audited — this is your work:** review flows
(`core/src/session/review.rs`), inter-agent communication replay, anything
`/btw`-shaped, the `compact_remote_v2` prefill path, guardian/subagent
spawns, and any exporter or transcript dump. For each: does it read native
state (fine) or would it need LHC's view (a Chunk 2 design input)?

Also enumerate **every fail-open path** in what Chunk 1 landed plus what
Chunk 2 will touch. FORK.md law 3: every fallback must fall back to a body
that **fits the window**. For each, state what it falls back to and whether
that body is bounded.

Deliverable: the census file, plus a short list of anything that changes the
bridge design.

## B. Facts already established — build on these, re-verify at your tip

- All three native compaction arms route through
  `Session::replace_compacted_history`: `compact.rs:373`,
  `compact_remote.rs:284`, `compact_remote_v2.rs:306`, plus auto-compact at
  `session/mod.rs:3672`. An LHC arm using the same API is identical in kind
  to the native arms — write-back by construction (law 1).
- `state/session.rs:114 replace_history` calls
  `auto_compact_window.clear_prefill()`, so the LHC replacement is observed
  by the auto-compact window exactly as native compaction is. **Law 2 is
  therefore a coverage obligation, not a design risk** — but it still needs
  the threshold-untrips test: compact once, counter drops, no re-trigger next
  turn. Write that test in this round if you can do it without the bridge; if
  it genuinely needs the LHC arm, say so and defer it to 2b.
- Ladder order in `tasks/compact.rs::run`: `TokenBudget` (early return) →
  `should_use_remote_compact_task` ? (`RemoteCompactionV2` ? remote_v2 :
  remote) : local. **`TokenBudget` returns early**, so an LHC arm placed
  below it would be bypassed whenever that feature is on. Recommend a
  placement with reasons; do not implement it yet.
- Inference is zero-patch: `core/src/lib.rs:182-183` exports `ModelClient`
  and `ModelClientSession`.

## C. The band-shape harness — BUILD IT, DO NOT RUN IT

FORK.md schedules this "Chunk 2, BEFORE the bridge is built": whether Codex
models tolerate band-shaped replacement history, given they are tuned for
their own compaction-summary shape.

Build a harness that:
1. constructs a realistic band-shaped history from a real captured LHC thread
   (use Chunk 1's capture — this is the first real consumer of it);
2. installs it via `replace_compacted_history` on a throwaway session;
3. continues N turns and captures the model's responses for judging;
4. records inputs and outputs to a file for review — coherence is judged from
   the transcript, not asserted by the harness.

**Do not execute it against a live model.** The auth lane is an open decision
with Lee (`OPENAI_API_KEY` is unset; the only lane available is his ChatGPT
plan, and derivation traffic on it spends plan quota). Leave the harness
runnable behind an explicit flag or a documented command, and say exactly
what command runs it and what it will cost per run (turns × approximate
tokens).

Make it cheap: smallest history that still exercises band shape, fewest turns
that would reveal incoherence.

## D. Standing rules — unchanged, and now the bar

**Rule zero still binds.** Any test certifying what LHC records round-trips
through a real `LhcSession` and reads the stored row back; any test
certifying core behaviour runs through core's production path.
`include_str!` source-text assertions are **banned as certification** — this
is not negotiable and was the whole of fix round 4.

Sentinels, `EXPECTED_HOOKS`, FORK.md inventory and `patches/lhc/` stay in
lockstep with any hook change. If this round adds no core touchpoint (it
should not), say so explicitly.

## Report

The census summary (with anything that changes the bridge design called out),
your ladder-placement recommendation with reasons, the harness command and
its per-run cost, and the tripwire output. State the 22-unit position and
what remains. Flag anything you believe needs Lee rather than deciding it.
