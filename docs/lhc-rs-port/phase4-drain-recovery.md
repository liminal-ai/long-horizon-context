# LHC compact bridge — derivation cadence, and a deadlock left behind

Working tree: `/srv/work/codex`, branch `lhc`. Dirty, uncommitted, nothing
pushed. **Do not commit, do not push.** No live model calls.

## What this system is

`long-horizon-context` (LHC) keeps durable, long-horizon conversation context
in a per-thread SQLite file. It derives compressed representations of a
conversation — smoothed prompts, per-turn compressions, chunk briefs — and can
serve a compacted "band-shaped" view of a thread that is much smaller than the
raw history but still coherent.

This fork wires LHC into OpenAI Codex (Rust). Two seams:

- **Capture** — Codex's raw `ResponseItem`s are mapped into LHC message events
  as a session runs.
- **Compact bridge** — when Codex wants to compact, an LHC arm runs before the
  native ladder: LHC produces the compacted body via its own `compact()`, the
  host maps it back to `ResponseItem`s and installs it through
  `Session::replace_compacted_history`. On any failure it fails open to
  Codex's own compaction.

Read first, in this order:

- `/srv/work/long-horizon-context/docs/onboard/01-core-concepts.md`
- `/srv/work/long-horizon-context/docs/onboard/02-domain-design.md`
- `/srv/work/codex/FORK.md` — the fork's binding laws and touchpoint inventory
- `/srv/work/codex/codex-rs/lhc/CHUNK3-CERTIFICATION.md` — what has been
  measured, and the named gaps

The LHC Rust source is vendored at
`/srv/work/codex/codex-rs/lhc/vendor/long-horizon-context/packages/lhc-rs/`
(pinned; treat as read-only). The host adapter is
`/srv/work/codex/codex-rs/lhc/codex-lhc-host/`. Core touchpoints are in
`codex-rs/core/src/` — `compact_lhc.rs`, `lhc_inference_bridge.rs`, plus hooks
in `session/mod.rs`, `session/turn.rs`, `tasks/compact.rs`.

Ignore `packages/codex-lhc` in the LHC repo — that is an abandoned TypeScript
wrapper approach, not this integration.

## The problem being fixed

LHC has two host modes, chosen at SDK construction (`01-core-concepts.md`):
background, where the scheduler drains derivation work automatically after
each intake commit; and manual, where the scheduler is inert and the host must
call `work.drain` itself.

This adapter was constructed in **manual** mode, and nothing called
`work.drain`. So no derivation ever ran: every band was a degraded excerpt
fallback, and the inference path was effectively dead code.

That was misdiagnosed. The correction applied was to call `work.drain`
explicitly at compact time, plus a hand-rolled background pump on
`on_thread_idle`. That made the host do the scheduler's job, serially, at the
moment of compaction. Measured consequences: ~2 derivation calls per turn all
deferred to compact time, strictly serial, 62 calls taking ~103s against a 75s
budget, and an apparent ~29k-token ceiling above which compaction would always
fail open. Those numbers describe the misconfiguration, not LHC.

## Current state on disk

A correction was in progress and was interrupted. Already applied:

- capture path opens `SdkMode::Background` (`codex-lhc-host/src/session.rs`)
- the compact-time drain loop and its batching constants are deleted
- the idle pump and its tests are deleted

Left broken by that interruption: `LhcSession::close()`
(`codex-lhc-host/src/session.rs:242`) awaits `drain_settled` with no bound.
With a live scheduler this does not return when derivation cannot settle, and
`cargo test -p codex-lhc-host --features test-util --test certification`
deadlocks on it. There is a bounded pattern already in the tree —
`capture.rs:266` takes a `Duration`, `install.rs:904` passes one.

The previous agent found that deadlock and then lost roughly an hour to it,
re-running the same suite under ten-minute timeouts. If a run stops producing
output, kill it and find out why before running it again; a hung suite tells
you nothing by being run twice.

## What needs to be true when you are done

Derivation happens as the session runs, not in a burst at compaction.
Compaction waits only briefly for quiescence and fails open to Codex's native
compaction if it cannot proceed. Nothing hangs — not `close()`, not the test
suites, not a session shutdown. The pieces that were built for correctness
rather than for cadence still hold: fail-open on derivation failure,
identity-based derived provenance so a served body is never re-ingested as
source, turn cancellation reaching the arm, and derivation prompts that do not
carry Codex's agent instructions.

Assess the whole shape before changing it — the interrupted round may have
left other loose ends, and some of what was built to compensate for the wrong
cadence may now be dead weight or actively wrong.

## Working rules

- `./scripts/check-lhc-hooks.sh` is the gate; it must be green. It includes a
  recovery drill that applies `patches/lhc/*.patch` at the recorded upstream
  base and requires byte-identity with the tree, so regenerate patches if you
  touch covered files.
- Tests drive production paths. No source-text/`include_str!` assertions.
  Prove an invariant by breaking it and watching the test fail.
- Never run workspace-level `cargo fmt` — it reformats the vendored submodule
  and dirties the pin.
- Report what you could not verify as plainly as what you could.
