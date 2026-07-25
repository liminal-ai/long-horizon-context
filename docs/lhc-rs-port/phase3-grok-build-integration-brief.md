# Phase 3 brief — integrate certified LHC Rust SDK into Grok Build

## Mission and position

Phase 3 turns the certified host-agnostic `lhc` Cargo library from Phase 2
into the user-facing deliverable: LHC-backed context management running inside
Lee's fork `liminal-ai/grok-build-lhc`, checked out at
`/srv/work/grok-build`.

This is Phase 3 of 3, approximately units 16–18 of 18. Do not begin until the
Phase 2 completion audit accepts the library. Grok Build integration must not
reshape the certified LHC semantics to fit the host; host-specific translation
lives in a narrow adapter layer.

## Authorities and repositories

- Certified SDK: `/srv/work/long-horizon-context/packages/lhc-rs`
- Host fork: `/srv/work/grok-build`
  (`origin = liminal-ai/grok-build-lhc`, `upstream = xai-org/grok-build`)
- Relevant host boundaries to audit before editing:
  - `crates/codegen/xai-chat-state` — canonical conversation actor,
    persistence, request construction, compaction triggers;
  - `crates/common/xai-grok-compaction` — current transport-agnostic
    compaction engine;
  - `crates/codegen/xai-grok-sampling-types` and sampler/shell sampling paths;
  - agent/session lifecycle, replay, forks/subagents, model switching,
    cancellation, and configuration.

Read any host `AGENTS.md` and current upstream divergence before each chunk.
Work on a dedicated branch. Preserve an immediate feature-flag/config rollback
to the existing compaction path until live certification is complete.

## Chunk 1 — packaging, session identity, and event capture

1. Choose and document ordinary Cargo consumption of `lhc` (workspace/path
   during development; a pinned reproducible source for the final fork).
   No C ABI, subprocess, service boundary, or duplicated port.
2. Create a narrow Grok adapter crate/module. It owns:
   - per-session LHC instance/thread lifecycle and storage path;
   - deterministic mapping from Grok `ConversationItem`/turn/tool/model events
     to LHC `MessageEventInput`;
   - stable idempotency keys across persistence, replay, resume, rewind,
     retries, session forks, and process restart;
   - explicit close/teardown and error/telemetry translation.
3. Capture the complete semantic stream in order: user prompts, assistant
   text/thinking, runtime notes, tool call/results, model/thinking changes,
   and turn end. Never scrape rendered terminal text.
4. Define migration/bootstrap for pre-LHC sessions without rewriting original
   `chat_history.jsonl`; prove replay is idempotent and source history remains
   the recovery authority until cutover is certified.

Certification:

- mapping table and golden event transcripts for every variant;
- restart/replay/fork/rewind/idempotency/concurrency tests;
- no loss or duplication under injected crashes;
- Phase 2 crate gate remains green in its source repo;
- host default behavior remains unchanged while the flag is off.

## Chunk 2 — inference adapter and context/compaction injection

1. Implement LHC `ModelCall` using Grok's in-process sampling abstraction.
   Preserve cancellation, model identity, token limits, timeout/failure
   classification, request/response provenance, and no nested host deadlock.
2. At the canonical `xai-chat-state` request-builder boundary, obtain LHC's
   current request context and translate it to sampling `ConversationItem`s
   without altering system/tool semantics or leaving dangling tool calls.
3. Integrate compact/preview/prune at the existing auto-compaction trigger.
   Decide explicitly—against live host behavior—whether LHC replaces or
   shadows `xai-grok-compaction`; do not run two writers on one request.
4. Preserve token-accounting/provider-overhead contracts, conversation actor
   ordering, turn-tail capture, model switching, live abort, retries, and
   manual compaction/rewind semantics.

Certification:

- adapter contract tests with deterministic mock sampler;
- byte/structure goldens from captured history → LHC context → sampling request;
- threshold/abort/failure/fallback/concurrent-request tests;
- comparison against existing compaction on representative long sessions;
- no context injection when disabled or when LHC fails under the chosen
  fail-open/fail-closed policy (that policy requires an explicit ruling if TS
  and host contracts do not uniquely determine it).

## Chunk 3 — product wiring, migration, and live certification

1. Add user/admin configuration, storage discovery, status/inspect/repair
   surfaces, diagnostics, privacy/redaction, and telemetry consistent with
   existing Grok Build conventions. No silent remote upload of LHC SQLite.
2. Exercise CLI, ACP, leader/subagent, session resume/import, model switch,
   manual/automatic compaction, and shutdown/crash recovery paths.
3. Provide safe rollout:
   - off-by-default or agreed cohort gate;
   - per-session opt-in and explicit fallback;
   - no irreversible migration before validation;
   - observable health and a documented rollback procedure.
4. Run long live sessions on Lee's fork with actual sampling, tool use,
   compaction, restart, and resumed context. Capture evidence sufficient to
   prove LHC—not the legacy path—constructed the request.

Done definition:

- LHC-backed capture/context/compaction is exercised end-to-end in Grok Build;
- certified Phase 2 semantics remain unchanged and its 496-test gate stays
  green;
- host unit/integration/e2e suites and formatting/lints pass;
- replay/restart/fork/cancellation/failure/rollback evidence is green;
- no dangling tool calls, lost turns, duplicate events, cross-session state,
  SQLite corruption, or leaked background tasks;
- configuration and diagnostics make the active context engine unambiguous;
- Lee can run a real session, inspect LHC state, observe compaction, restart,
  and continue with correct context.

## Orchestration

Each chunk follows the same implement → independent Sol/Fable audit → repair →
changed-scope confirmation → orchestrator gate/commit/push loop. Report every
chunk against the full three-phase deliverable. Apply the current escalation
rule: decide documented uniquely forced changes; stop only for denominator/
done-definition, scope/plan/deliverable movement, genuine divergent ambiguity,
judgment-ruling reversal, or a persistent gate failure.
