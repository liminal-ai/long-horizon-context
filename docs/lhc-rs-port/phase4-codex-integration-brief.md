# Phase 4 brief — integrate certified LHC Rust SDK into Codex

## Mission and position

Phase 4 puts the same certified `lhc` Cargo library that Phase 3 is wiring
into Grok Build inside OpenAI's Codex CLI: Lee's fork
`liminal-ai/codex-lhc` (exists; local checkout `/srv/work/codex`,
`origin = liminal-ai/codex-lhc`, `upstream = openai/codex`) with LHC-backed
capture and compaction usable in real Codex sessions.

**This is a Lee-directed scope extension beyond the original 18 units.**
The project denominator is now **~22 units**: Phases 1–2 (port, units
1–15) DONE; Phase 3 (Grok Build, units 16–18) in progress; **Phase 4 =
units 19–22** (Chunk 0 fork discipline + 3 integration chunks). Report
against the 22-unit frame; never present Phase 4 progress inside a
smaller one. Phase 4 does not start until Lee explicitly kicks it off —
this brief exists so analysis is not redone at kickoff. Sequencing
relative to Phase 3 (after, or parallel with a second orchestrator) is
Lee's call at kickoff; the port crate is consumed read-only via submodule
pins by both forks, so parallel execution has no shared-write conflict.

Seam facts below were **verified against upstream tip `4c43465133`
(2026-07-25)**, re-checked from the 2026-07-24 feasibility audit. Line
numbers WILL rot within days (see churn); symbols are the durable
reference. Re-verify each seam at the current tip before building on it;
a vanished seam is an escalation discovery, not something to route around.

## Upstream model (different from grok-build — read carefully)

- Normal public git history, external PRs accepted, no squash-sync resets
  expected. Fork strategy is **merge-based**; the patch series is
  retained anyway as cheap uniformity with grok-build-lhc (one drill for
  the future maintainer agent) and as insurance.
- **Churn is the defining constraint: ~760 commits in the last 30 days**,
  and the capture hook file (`core/src/session/mod.rs`) alone took **70
  commits/30d**. Expect hook-adjacent conflicts on most syncs — this is
  the fork where sentinel tripwires earn their keep. Sync weekly minimum;
  going two weeks behind makes merges materially harder.
- **Active migration risk, watch every sync:** compaction dispatch
  (`core/src/tasks/compact.rs::run`) is a feature-gated ladder already
  carrying `Feature::RemoteCompactionV2` — upstream is moving compaction
  provider-side. If the local dispatch sites shrink toward
  deprecation, the LHC arm's placement needs redesign; surface to Lee
  at that sync, do not improvise.

## Host seam map (symbol-level; verified 2026-07-25)

- **Capture (Chunk 1):** every conversation item funnels through
  `Session::record_conversation_items` (`core/src/session/mod.rs`,
  `pub(crate)`). The extension system (`ext/extension-api`, compile-time
  registry, built in `app-server/src/extensions.rs` via
  `ExtensionRegistryBuilder`; TUI and exec both ride the in-process
  app-server, so one registration site covers the main frontends) has
  rich contributor traits but **none carries item-level payloads** —
  capture needs one additive trait (`RawItemContributor`-style: raw
  `ResponseItem`s, pre-normalization, including encrypted reasoning
  payloads and exact function-call JSON) plus ~2 hook lines in
  `record_conversation_items`. That is the whole capture patch.
- **Free lifecycle hooks (Chunk 1, zero-patch):**
  `ThreadLifecycleContributor` (`on_thread_start/resume/idle/stop`) and
  `TurnLifecycleContributor` (`on_turn_start/stop/abort/error`) in
  `ext/extension-api/src/contributors.rs` — turn boundaries and thread
  lifecycle come free, and **`on_thread_idle` is a natural background-
  drain pump** (the Hermes per-turn-drain lesson, already provided by
  this host). `ContextContributor`/`TurnInputContributor` exist but are
  prompt-fragment-shaped — not a capture path.
- **Rebuild/serving (Chunk 2):** `Session::replace_compacted_history`
  (`core/src/session/mod.rs`) accepts an arbitrary replacement history,
  persists it verbatim in the rollout log, and resume replays it
  faithfully — the certification-friendly mechanism. The compact bridge
  is one new feature-gated arm in the `tasks/compact.rs::run` ladder
  (order today: TokenBudget → remote_v2 → remote → local) plus the
  auto-compact trigger path (`auto_compact_window_snapshot` and
  neighbors in `session/mod.rs`). Gate behind a `codex-features` flag
  (config.toml-gated), rollback = flag off.
- **Inference (Chunk 2): improved since the audit — zero patch.**
  `ModelClient` and `ModelClientSession` are now publicly exported from
  core (`core/src/lib.rs`: `pub use client::ModelClient`). LHC's
  ModelCall consumes them directly; the audit's re-export/reimplement
  workaround is obsolete. Caveat unchanged: derivation calls ride the
  user's auth lane — under a ChatGPT plan this spends plan quota and may
  look anomalous; prefer a dedicated/API-key lane config, decided with
  Lee at Chunk 2.
- **Certification level:** core's ContextManager normalizes items, so
  certify at the rollout/replacement-history level (bytes LHC hands
  over vs bytes persisted/replayed), not at raw request level.
- **Scope:** main session only; subagent/multi-thread capture is a
  recorded non-goal until after live cert (same ruling as grok-build).

## Chunk 0 — fork discipline (mirror grok-build-lhc, merge-based flavor)

Replicate the grok-build-lhc Chunk 0 exactly, adapted:

1. Branch `lhc` from upstream tip; `main` tracks upstream; default branch
   `lhc`; description set (already done at fork creation).
2. Fork code in `codex-rs/lhc/` (vendored `long-horizon-context`
   submodule pinned to certified `lhc-rs-port` commits + `codex-lhc-host`
   adapter crate, standalone workspace until the members entry lands).
   Root `codex-rs/Cargo.toml` is hand-maintained upstream (not
   auto-generated like grok-build's) but heavily trafficked — the
   members entry is still patch 0001, sentinel-marked with `# LHC-HOOK`
   (TOML comment syntax).
3. `FORK.md`, `patches/`, `scripts/check-lhc-hooks.sh` — same three-layer
   tripwire (sentinel count / compile / golden smoke), same
   hook-change-updates-all-three-in-one-commit rule, same runbook
   standard: a fresh maintainer agent can sync from FORK.md alone.
   Expected hooks: ~4 (capture trait registration line, 2 capture hook
   lines, compact dispatch arm) — enumerate precisely as they land.
4. Sync drill notes the two codex-specific watch items: session/mod.rs
   conflict likelihood, and the RemoteCompactionV2 ladder-shape check.

## Chunk 1 — capture

1. Additive `RawItemContributor` trait in `ext/extension-api` + hook
   lines in `record_conversation_items`; registration in
   `app-server/src/extensions.rs`. Adapter maps raw items →
   `MessageEventInput` (full fidelity: encrypted reasoning passthrough,
   exact function-call JSON, model/thinking changes), turn boundaries
   from `TurnLifecycleContributor`, background drain pumped from
   `on_thread_idle`.
2. Idempotency keys stable across resume/replay/retry/restart; rollout
   file remains untouched recovery authority until cutover certified.
3. Certification: mapping table + golden transcripts per item variant;
   restart/replay/idempotency/crash-injection; host default behavior
   unchanged with the flag off; port gate green at the pinned commit.
4. Consider (flag to Lee, not decide): upstreaming the additive trait as
   a PR once proven — this upstream accepts PRs, and upstreaming
   deletes the fork's riskiest hook.

## Chunk 2 — rebuild, compact bridge, inference

1. LHC `ModelCall` over public `ModelClient`; auth-lane decision with
   Lee (plan-quota contamination). Cancellation, token limits, failure
   classification preserved.
2. Request-context serving + compact bridge: feature-gated LHC arm in
   the compact ladder; `replace_compacted_history` carries LHC's rebuilt
   view; decide explicitly (against live behavior) whether LHC replaces
   or wraps native auto-compact triggering.
3. **The empirical unknown, front-load it:** whether Codex models
   tolerate band-shaped replacement history (they are tuned for their
   own compaction-summary shape). Run the eval BEFORE building the full
   bridge — a cheap harness feeding band-shaped history through
   `replace_compacted_history` on a throwaway session, judged on
   coherence of continued turns. If intolerant, the mitigation
   (shape-adapting the band render) is a Lee decision, not an
   improvisation.
4. Certification: export/diff at rollout level across compact + resume;
   fidelity certification pattern from pi-lhc/t3code (reconciled entries,
   classified divergences, zero unexplained).

## Chunk 3 — live certification and sync rehearsal

1. Long real sessions on the fork (real tool use, real compacts, resume,
   abort paths), KV/prefix-cache impact measured, auth-lane behavior
   under the chosen config verified.
2. One full upstream sync run through the FORK.md drill with hooks live
   (given churn, this will exercise conflicts for real), plus the
   history-reset recovery drill rehearsal (uniformity with grok-build,
   even though resets are unlikely here).
3. Sign-off = Lee using LHC-backed Codex sessions for real work.

## Risks (ranked)

1. **session/mod.rs churn** (70 commits/30d on the capture hook file) —
   mitigated by tiny hook footprint + sentinels + weekly syncs.
2. **RemoteCompactionV2 migration** — the local dispatch ladder may lose
   authority; watch every sync, escalate on shape change.
3. **Band-shape tolerance** — unverified model behavior; front-loaded
   eval in Chunk 2 before the bridge is built.
4. **Auth contamination** — derivation traffic on user auth; decided
   lane config at Chunk 2.
5. **Encrypted reasoning** — capture stores what the wire carries;
   fidelity ceiling documented if payloads are opaque (same class as the
   t3code narration-redaction ceiling: provider-side, not fork bugs).
