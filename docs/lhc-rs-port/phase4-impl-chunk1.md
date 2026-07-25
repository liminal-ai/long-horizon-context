# Phase 4 / Chunk 1 — LHC capture in Codex (implementor brief)

## Position (state this frame in your report; never a smaller one)

Project = **22 units**. Phases 1–2 (the host-agnostic Rust port, units 1–15)
are DONE and dual-certified. Phase 3 (Grok Build integration, units 16–18) is
in progress. **Phase 4 = units 19–22**: Chunk 0 (fork discipline) is DONE;
**you are building Chunk 1 = unit 20 of 22**. Completing it delivers capture
only — no compaction, no user-facing benefit. Chunks 2 and 3 remain and are
the larger part. Any "done" you write must say what remains.

## Repo, branch, ground rules

- Work repo: **`/srv/work/codex`, branch `lhc`** (origin
  `liminal-ai/codex-lhc`, upstream `openai/codex`). **Never push. Never
  commit.** The orchestrator is the sole committer. Leave your work in the
  working tree.
- **Read `/srv/work/codex/FORK.md` first, in full.** Its laws and its
  touchpoint/tripwire discipline are binding on every line you write.
- Plan of record: `docs/lhc-rs-port/phase4-codex-integration-brief.md` in
  `/srv/work/long-horizon-context` (read the seam map and the "Laws from the
  Phase 3 Chunk 2 escalation" section — all of it applies here).
- All LHC logic lives in `codex-rs/lhc/codex-lhc-host`. Core files get
  **hook lines only** — a marked call into the adapter, nothing more. If you
  find yourself writing LHC logic inside `codex-rs/core`, stop: that is the
  wrong design.
- Rust conventions carried from the port: **no wildcard `_ =>` arms on
  closed-vocabulary matches** (enumerate every variant so upstream adding one
  breaks the build — that is the point); `skip_serializing_if` on optional
  serialized fields; no `serde_json::to_string` where JS-parity bytes matter
  (use `lhc::shared_tech::js_json`).

## Verified seam facts (re-verified at tip `322d5b96cf`, 2026-07-25)

These are checked, not assumed. If any is false when you look, that is an
escalation discovery — report it, do not route around it.

1. **`Session::record_conversation_items`** — `core/src/session/mod.rs:2977`,
   `pub(crate)`. Every conversation item funnels through it. It calls
   `prepare_conversation_items_for_history`, records to state, persists the
   rollout, then calls `send_raw_response_items`.
2. **`Session::send_raw_response_items`** — `core/src/session/mod.rs:3284`,
   private, **two call sites**: `record_conversation_items` (:2993) and
   `record_inter_agent_communication` (:3115). It already fans every raw
   `ResponseItem` out as `EventMsg::RawResponseItem`. **A single hook line
   inside this function covers both recording paths** — prefer that to two
   hook lines in the callers unless you can show a reason it is wrong (say
   which you chose and why).
3. **`replace_compacted_history`** — `core/src/session/mod.rs:3188`. It calls
   `state.replace_history(...)` and `persist_rollout_items(Compacted)`
   directly. **It does NOT route through `record_conversation_items` or
   `send_raw_response_items`.** So LHC's Chunk 2 write-back will *not*
   re-enter capture through this seam. This answers the Phase 4 brief's open
   question (law 4) — but you still owe the idempotency guarantees in
   "Certification" below, because resume/replay/retry all re-present items.
4. **Extension contributor traits** — `ext/extension-api/src/contributors.rs`
   and `contributors/`. `ThreadLifecycleContributor`
   (`on_thread_start/resume/idle/stop`) and `TurnLifecycleContributor`
   (`on_turn_start/stop/abort/error`) exist and are free. Registration is via
   `ExtensionRegistryBuilder::{thread_lifecycle_contributor,
   turn_lifecycle_contributor, ...}` (`ext/extension-api/src/registry.rs`).
   **No existing trait carries item-level payloads** — `ContextContributor`
   and `TurnInputContributor` are prompt-fragment-shaped;
   `TurnItemContributor` operates on a parsed `TurnItem`, not the raw
   `ResponseItem`. Confirm this yourself before adding a trait.
5. **Thread identity is already available to extensions, with no core
   change:** `thread_extension_data` is constructed as
   `ExtensionData::new(thread_id.to_string())` (`core/src/session/session.rs`),
   and `ExtensionData::level_id()` (`ext/extension-api/src/state.rs`) returns
   it. Turn identity arrives as `TurnStartInput::turn_id`. **Do not add
   `thread_id` fields to lifecycle inputs** — key off `thread_store.level_id()`
   and stash your per-thread handle in the thread-scoped `ExtensionData`.
   (`TurnStopInput` carries no `turn_id`; the turn-scoped store is the
   correlation handle — use it.)
6. **Registration site**: `app-server/src/extensions.rs::thread_extensions`
   builds the registry (`ExtensionRegistryBuilder::<Config>::with_event_sink`,
   then `codex_goal_extension::install_with_backend(&mut builder, ...)` —
   **copy that `install_*` shape**). TUI and exec both ride the in-process
   app-server, so this one site covers the main frontends. Verify that claim
   and say so in your report.
7. **`ResponseItem`** — `protocol/src/models.rs:799`, 17 variants:
   `AdditionalTools, Message, AgentMessage, Reasoning, LocalShellCall,
   FunctionCall, ToolSearchCall, FunctionCallOutput, CustomToolCall,
   CustomToolCallOutput, ToolSearchOutput, WebSearchCall,
   ImageGenerationCall, Compaction, CompactionTrigger, ContextCompaction,
   Other`. Every one needs a mapping decision (see below).
8. **LHC event-kind vocabulary is closed** (`lhc::intake_stream::EventKind`,
   vendored at `codex-rs/lhc/vendor/long-horizon-context/packages/lhc-rs/
   src/intake_stream/mod.rs:26`): `user_prompt, assistant_text,
   assistant_thinking, runtime_note, model_change, thinking_level_change,
   tool_call, tool_result, turn_end`. You map into this vocabulary; you do
   not extend it.

## Prior art — read it before designing (do not copy blindly)

Grok Build's Chunk 1 adapter solved this same problem against a different
host: `/srv/work/grok-build/crates/lhc/grok-lhc-host/src/` —
`idempotency.rs` (stable key shape, `OccurrenceTracker` seeded from LHC's
stored events, session-id escaping), `mapping.rs` (item → `MessageEventInput`),
`capture.rs` (bounded-queue background worker + session registry), `tee.rs`.
Its `idempotency.rs` header comments record *why* each choice was made —
those reasons are the transferable part. Codex's item model is different
(typed `ResponseItem` enum, `call_id`s, `ResponseItemId`s, encrypted
reasoning); do not assume the Grok key shape ports unchanged. State
explicitly in your report which decisions you carried over and which you
changed, with the reason.

## Deliverables

### A. Core touchpoints (hook lines only, each sentinel-marked)

Every core line you add or change carries an `LHC-HOOK n/N` marker
(`// LHC-HOOK` in `.rs`, `# LHC-HOOK` in `.toml`) with a one-line purpose.
Enumerate them precisely — the count is not guessed, it is the number you
actually land.

1. `codex-rs/Cargo.toml` — workspace members entry for
   `lhc/codex-lhc-host`, and remove the crate's standalone `[workspace]`
   stanza in its own `Cargo.toml`. This is **patch 0001**.
2. `ext/extension-api` — the additive `RawItemContributor` trait + its input
   struct + registry field, builder method, and accessor. Additive only:
   no existing trait, struct, or signature changes shape. (Design it to be
   upstreamable as a PR — that is a recorded Chunk-3 follow-up, and it is
   why "additive only" is hard here.)
3. `core/src/session/mod.rs` — the raw-item hook (see seam fact 2).
4. `app-server/src/extensions.rs` (+ its `Cargo.toml` dependency) —
   `codex_lhc_host::install(&mut builder, ...)`, gated (see D).

### B. Adapter crate — `codex-rs/lhc/codex-lhc-host`

Suggested module split (justify any deviation): `install.rs` (registry
wiring), `mapping.rs` (`ResponseItem` → `MessageEventInput`),
`idempotency.rs`, `capture.rs` (background worker + per-thread session
handle), `gating.rs` (feature flag).

**Mapping requirements — full fidelity is the deliverable:**

- Produce a **mapping table** in the module docs: every one of the 17
  `ResponseItem` variants → its LHC `event_kind` and payload shape, or an
  explicit, reasoned "not captured". Exhaustive `match`, no `_ =>` arm.
- `Reasoning.encrypted_content` passes through **verbatim**. If a payload is
  opaque, capture the bytes as-is and record the fidelity ceiling in the docs
  — do not drop it, do not summarize it.
- `FunctionCall.arguments` is a raw JSON **string** from the wire — preserve
  it byte-exact; do not parse-and-reserialize.
- Structured items stay structured in durable state (FORK.md law 5). Never
  flatten an item to prose.
- Correlate calls and outputs by `call_id`, never by content.

**Capture worker requirements:**

- Bounded queue; capture must **never block or slow the session path** and
  must never panic into core. A full queue drops with a loud `warn` and a
  counter — and the drop must be visible to certification, not silent.
- Background drain pumped from `on_thread_idle`.
- Turn boundaries from `TurnLifecycleContributor`: `on_turn_start` /
  `on_turn_stop`; `on_turn_abort` and `on_turn_error` must leave the LHC
  record in a consistent state (an aborted turn is a real, recurring shape —
  decide its `turn_end` semantics explicitly and test it).
- Thread lifecycle: open on first use keyed by `thread_store.level_id()`,
  flush and close on `on_thread_stop`.

**Idempotency requirements (the crux):**

- Keys stable across **resume, replay, retry, and process restart**. The
  same logical item recorded twice must produce the same key; two genuinely
  distinct occurrences of an identical item must not collide.
- Seed occurrence counters from **LHC's stored events** at open, never from
  the host's in-memory slice alone.
- The rollout file remains the untouched recovery authority. LHC is a
  parallel record this chunk, not a replacement.

### C. Certification (this is the deliverable, not an afterthought)

- **Mapping goldens**: a golden transcript per item variant, checked in under
  `codex-rs/lhc/goldens/`. **FORK.md law: fixtures must be shapes the host
  can actually produce** — derive them from real host construction paths
  (core's own test helpers build real `ResponseItem`s; use them), not from
  hand-written JSON that nothing emits. For any fixture you cannot derive
  from a real path, say so explicitly and justify its reachability.
- **Idempotency/restart/replay tests**, including **crash injection**: a
  capture interrupted mid-flight must, on retry, record exactly once —
  never zero, never twice.
- **Flag-off test**: with the feature disabled, host behavior is
  byte-identical to upstream and no LHC code runs.
- **FORK.md law 3 — a test that cannot fail is not a test.** For every test
  guarding an invariant this brief calls hard (idempotency-under-retry,
  ordering across resume, encrypted-payload passthrough, flag-off
  inertness): break the production code, run the test, watch it fail,
  restore. **Report the actual failure output per test.** An argument that
  it would fail is not evidence and will be rejected.
- **Know what your gate runs** (law 3 corollary): unit tests in `src/` need
  `--lib`. Layer 3 of `scripts/check-lhc-hooks.sh` is currently a loud skip
  pending goldens — **arm it in this chunk** and make its header enumeration
  truthful.

### D. Gating

Feature-flag the whole thing (`codex-rs/features`, config.toml-gated, in the
`Feature` enum alongside `TokenBudget`/`RemoteCompactionV2`). Default OFF.
Rollback = flag off. Flag off must mean *no LHC code paths execute*, not
"LHC runs and discards".

### E. Fork discipline — same-commit rule

Because you do not commit, deliver these as edits in the working tree,
ready for the orchestrator's single commit:

- `EXPECTED_HOOKS` in `scripts/check-lhc-hooks.sh` updated to your actual
  count (currently 0), and the script header's "WHAT THIS SCRIPT ACTUALLY
  RUNS" list kept truthful.
- FORK.md touchpoint inventory table filled in — one row per hook, with
  file, marker, purpose, patch.
- `patches/` series regenerated per FORK.md. **Note:** the repo root
  `patches/` directory is upstream's third-party patch collection. Put the
  LHC series somewhere unambiguous (`patches/lhc/`), add a README, and say
  in your report that you did — FORK.md's line 23 needs correcting to match.
- `./scripts/check-lhc-hooks.sh` green, output pasted in your report.

## Escalate (stop and report, do not improvise)

- A seam above is not what this brief says it is.
- Capture cannot be done without a **non-additive** core change, or a core
  touchpoint beyond the four enumerated in section A.
- Anything that would change the LHC crate's semantics to fit Codex. The
  vendored port is certified and read-only; if the adapter needs the port to
  behave differently, that is a stop.
- Genuine ambiguity where two defensible designs behave differently.

Otherwise: decide, cite the evidence in your report, and proceed.

## Report

Findings-and-decisions, with `file:line`. Required sections: the four
touchpoints as landed (with sentinel numbering); the 17-variant mapping
table; idempotency key shape and why it is restart-stable; **per-test
break-it-and-watch-it-fail output**; tripwire output; what you carried from
grok-build vs. changed; open questions. State the position frame from the
top of this brief. Do not claim Chunk 1 is "complete" without naming Chunks
2–3 as the larger remainder.
