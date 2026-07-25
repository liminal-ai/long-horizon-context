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

## Chunk 0 — fork discipline (before any hook lands)

The upstream is unlike t3code or hermes: `xai-org/grok-build` publishes via
daily monorepo squash-syncs (every commit is "Synced from monorepo",
6.7k-57k line diffs), accepts no external PRs, and may reset history without
notice. The fork must survive a history reset with zero archaeology. Set this
up FIRST — it is cheaper to build before the first hook than to retrofit.

1. **Layout.** All fork code lives in `crates/lhc/` (vendored `lhc` +
   `grok-lhc-host` adapter) — zero-collision directory, same isolation rule
   that survived three t3code upstream merges. Vendor `lhc` as a git
   submodule pinned to a certified commit of `long-horizon-context`
   (`lhc-rs-port` @ 358c8d1 or later) — the t3code pattern; never copy the
   port into the fork.
2. **Core touchpoints as a patch series, not just commits.** Every core-file
   insertion (expect ~3: persistence tee, compact bridge, request-builder
   read) is 1-5 lines, marked `// LHC-HOOK <n>/<total>: <purpose>`, and ALSO
   maintained as `patches/NNNN-*.patch` files (git format-patch output,
   regenerated whenever a hook changes) checked into the fork. On a normal
   sync these are redundant; on a history reset they are the recovery path:
   fresh clone of new upstream → re-add `crates/lhc/` → `git am patches/*`
   → tripwires. Recovery must be mechanical, documented in FORK.md, and
   rehearsed once before Chunk 3 sign-off.
3. **Tripwires, all three layers, in-fork and runnable by one script:**
   - sentinel count: `scripts/check-lhc-hooks.sh` greps the exact expected
     `LHC-HOOK` markers; wrong count = failed sync, stop;
   - compile: the adapter crate imports the host types it seams into, so
     upstream drift at a seam breaks the build loudly (prefer exhaustive
     matches over host enums at the seam — vocabulary drift becomes a
     compile error, the port's own rule 6 applied to the host boundary);
   - behavioral: the capture/rebuild golden smoke (Chunk 1 certification
     artifacts, rerun on every sync) — the sync-smoke drill that certified
     13/13 on t3code.
4. **Known recurring conflict:** the auto-generated root `Cargo.toml`
   workspace-members list will conflict on most syncs. The resolution rule
   (our members entry is part of patch 0001) lives in FORK.md so no sync
   ever improvises it.
5. **FORK.md at repo root** (upstream never touches it): what the fork adds,
   the touchpoint inventory (every owned core line, hook by hook), the sync
   drill, the history-reset recovery drill, submodule pin policy, and the
   never-run list (`grok upgrade` self-update against a source checkout).
   Make `lhc` the default branch, set the repo description — the
   scan-friendly fork presentation, same as hermes-lhc.
6. **Sync cadence:** weekly or on-need, not per upstream commit (upstream
   moves daily; the tripwires make each sync mechanical). Each sync commit
   body records: upstream range, tripwire results, sync-smoke verdict. This
   drill is designed to be handed to a maintainer agent later — write it so
   a fresh agent can run it from FORK.md alone.

**Chunk 1 status: DONE** (2026-07-25, fork `9ea06ea`..`af62816` on
`liminal-ai/grok-build-lhc` branch `lhc`). Capture running behind `GROK_LHC`
(off by default, host bit-identical when off): persistence tee, exhaustive
`ConversationItem` -> `MessageEventInput` mapping, model/thinking tee, session
identity and teardown. Three marked core hooks + the root workspace entry;
61 tests (20 unit / 37 certification / 4 golden); tripwire green with both
test binaries inside layer 3. Five repair rounds, dual adversarial verification
each. Orchestrator amendments recorded in the commit body: the sidecar->
`last_event_order` redesign (A1), the supersession of the orchestrator's own
"emit nothing on replace_history" ruling (B1), and a shipped `blocking_recv`
panic on the enabled path caught by an orchestrator probe (C1). Two accepted
limitations documented in FORK.md. **The history-reset recovery drill was
rehearsed at Chunk 1** against the raw upstream tip (brief asked for it before
Chunk 3; done early), record in `patches/README.md`.

Chunk 2 rulings made by the orchestrator, recorded here so they are not
re-litigated: compaction implements **both** `shadow` (default) and `replace`
(opt-in) modes, mutually exclusive by construction so two writers on one
request are impossible; and the failure policy is **fail open to the existing
path**, cited from this brief's own requirement to preserve an immediate
rollback to the existing compaction path until live certification.

**Chunk 0 status: DONE** (Fable, 2026-07-25, fork commit `f99b4fb` on
`liminal-ai/grok-build-lhc` branch `lhc`). Branched from upstream tip
`6e38642`; submodule pinned `e582465`; tripwires green (sentinel 0/0,
compile ok, golden smoke SKIP until Chunk 1 arms it); default branch and
description set. Per Lee, the dry-run sync rehearsal was waived — the first
real upstream sync (upstream moves daily) is the rehearsal; run the FORK.md
sync drill for it. Orchestrators: start at Chunk 1; read FORK.md first.

## Host seam map (symbol-level; from the 2026-07-24 feasibility audit)

Upstream churns daily, so line numbers are useless — these are the durable
crate/symbol-level findings. **Verify each at the current tip before
building on it**; if one has moved or vanished, that is your first
escalation-worthy discovery, not something to silently work around.

- **Capture (Chunk 1):** all conversation mutations flow through a single
  `ChatPersistence`-trait construction site in `xai-chat-state` — a tee
  decorator there is the whole capture hook. Model-change events ride a
  separate channel (small second tee, or derive from per-response fields).
  `chat_history.jsonl` is the model-facing record and natively carries
  tagged `ConversationItem`s including tool calls, reasoning items
  (round-tripped for KV-cache stability), and synthetic-input markers —
  richer native capture than any prior host. Open question from the audit:
  whether some models' reasoning items are encrypted-only.
- **Rebuild/serving (Chunk 2):** the host already has full-history
  substitution APIs — `load_session`, `replace_conversation` /
  `replace_conversation_for_compaction` — used by resume and native
  compaction. The compact bridge is a small patch at the existing
  auto-compact gate. **Hard constraint: substituted views must preserve
  `prompt_index` or rewind/fork break.**
- **Inference (Chunk 2):** native compaction already runs on a dedicated
  non-main model via a `CompactionSampler`-style trait over multi-backend
  `SamplingConfig` — LHC's ModelCall follows that template; the audit
  found zero core patch needed for this seam.
- **No in-process plugin registry** (`xai-grok-hooks` is external
  subprocess/HTTP only) — hence the marked-hook fork approach; there is
  nothing to register into.
- **Subagents have separate chat histories** — scope Phase 3 to the main
  session; subagent capture is a recorded non-goal until after live cert.
- **KV-cache economics:** compaction swaps bust the prefix cache by
  nature; measure during live cert (Chunk 3), don't pre-optimize.

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

### Host obligations from the Phase 2 acceptance record (PORT_STATUS.md)

- Timestamps the host passes into public APIs (`now`, lease times) MUST be
  canonical `YYYY-MM-DDTHH:MM:SS(.mmm)Z` — offset forms TS would accept are
  rejected/expired by design (Amendment D ceiling). Use LHC's own formatting
  helpers.
- Do not supply `SdkConfig.clock` in production — the ports differ in how far
  a configured clock reaches (recorded_at provenance); wall time is the
  cross-port-identical path.

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
