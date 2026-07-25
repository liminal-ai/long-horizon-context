# Chunk 1 implementor brief — capture: packaging, session identity, event capture

You are implementing **Chunk 1 of 3 of Phase 3 of 3** of the LHC project
(unit ~16 of 18 overall). Phases 1–2 (the Rust port of LHC) are DONE,
dual-certified, and frozen. Chunk 0 (fork discipline) is DONE. You are
integrating a certified library into a host — you are NOT porting, and you
do NOT change the certified library.

## Repos and rules

- **Work repo: `/srv/work/grok-build`, branch `lhc`.** All commits are mine
  (the orchestrator); you leave work on disk, uncommitted. Do not commit,
  do not push, do not touch `main`, do not run `grok upgrade`.
- **Read `/srv/work/grok-build/FORK.md` FIRST, in full.** Every rule in it
  is binding: hook marking, sentinel totals, patch series, the Cargo.toml
  conflict rule, host obligations toward LHC.
- The vendored certified port is at
  `crates/lhc/vendor/long-horizon-context/packages/lhc-rs` (git submodule,
  pinned). **It is read-only. Never edit it.** If you believe the port
  itself must change, STOP and report it — that is an escalation, not a fix.
- The adapter crate is `crates/lhc/grok-lhc-host/` — this is where
  essentially all of your code goes.

## The seam map (verified at the current tip, 2026-07-25 — re-check before editing)

- **Single production `ChatPersistence` construction site:**
  `crates/codegen/xai-grok-shell/src/session/acp_session_impl/spawn.rs`
  (~line 437-446): `ChatStateActor::spawn_with_pruning(..., Box::new(super::chat_persistence::ChannelChatPersistence::new(persistence.tx.clone())), ...)`.
  The actor owns persistence exclusively (`Box<dyn ChatPersistence>`,
  `&mut self` methods, no locks). **A tee decorator here is the whole
  capture hook.**
- Trait: `crates/codegen/xai-chat-state/src/persistence.rs` —
  `persist_message(&ConversationItem)`,
  `persist_working_directory_switch_and_ack(&ConversationItem) -> oneshot::Receiver<...>`,
  `replace_history(&[ConversationItem])`, `flush()`.
- Item vocabulary: `crates/codegen/xai-grok-sampling-types/src/conversation.rs`
  — `ConversationItem::{System, User, Assistant, ToolResult, BackendToolCall, Reasoning}`,
  plus `SyntheticReason` (18 variants incl. `#[serde(other)] Unknown`) and
  `UserItem::prompt_index`.
- Model switch: `crates/codegen/xai-grok-shell/src/agent/handlers/model_switch.rs`
  (broadcasts `SessionUpdate::ModelChanged`). Model/thinking changes do NOT
  flow through persistence — they need their own small tee.

## Enumerated core touchpoints for Chunk 1 — exactly these, no others

Any core edit outside this list is an escalation: STOP and report it.

| # | File | Purpose |
|---|------|---------|
| 1 | `crates/codegen/xai-grok-shell/Cargo.toml` | dependency on `grok-lhc-host` |
| 2 | `.../session/acp_session_impl/spawn.rs` | wrap persistence in the LHC tee |
| 3 | `.../agent/handlers/model_switch.rs` | model / thinking-level change tee |

Plus the root `Cargo.toml` workspace-members entry for
`crates/lhc/grok-lhc-host` (**no marker comment there** — the file is
auto-generated and sorted; a comment would be clobbered. Instead add a
dedicated named assertion for that entry to `scripts/check-lhc-hooks.sh`,
and follow FORK.md's Cargo.toml conflict rule).

Rules for hooks 1–3:
- 1–5 added lines each, purely additive, marked
  `// LHC-HOOK <n>/3: <purpose>` (`#` comment in the Cargo.toml).
- Every hook body is a single call into `grok_lhc_host` that is a **no-op
  when LHC is disabled** (see gating). No host logic moves into LHC.
- In the SAME change: set `EXPECTED_HOOKS=3` in `scripts/check-lhc-hooks.sh`,
  fill in FORK.md's touchpoint-inventory table (all three rows + the root
  Cargo.toml entry noted), and regenerate `patches/` per `patches/README.md`
  (I will do the actual `git format-patch` after committing — you write
  FORK.md and the script; leave a note in your report that patches are
  pending regeneration).

## Gating — off by default, non-negotiable

Host default behavior must be **bit-identical** with LHC off. Gate on env
var `GROK_LHC` (`1`/`true` = on; unset/anything else = off), read once at
session spawn. With it off: no LHC instance is constructed, no SQLite file
is created, no background task is spawned, and the tee is a transparent
pass-through (ideally not even installed). Add a test proving the disabled
path installs no decorator.

## What to build in `crates/lhc/grok-lhc-host/`

1. **Packaging.** Ordinary Cargo path dependency on the vendored `lhc`
   crate (already wired). Add `grok-lhc-host` to the root workspace so
   `xai-grok-shell` can depend on it; keep the crate's own `[workspace]`
   stanza removal consistent with becoming a member.
2. **Session/thread lifecycle.** Per-session LHC instance
   (`lhc::sdk::init_lhc(SdkConfig{..})`), thread creation/resolution via
   `Lhc::threads` (`new_thread` / `resolve` / `resolve_thread_ref`),
   storage under LHC's own registry convention (`~/.lhc/registry.sqlite`
   default — see `threads/internal/registry.rs`; make the root overridable
   by env for tests). Explicit close/teardown that flushes and drops the
   instance; no leaked background tasks.
   - **Do not set `SdkConfig.clock` in production** (FORK.md host
     obligation; wall time is the cross-port-identical path).
   - Any timestamp you pass into an LHC public API must be canonical
     `YYYY-MM-DDTHH:MM:SS(.mmm)Z`. If the port exposes no *public* helper
     for that, say so in your report rather than hand-rolling a format
     that drifts.
   - Chunk 1 needs no real inference. `init_lhc` requires exactly one of
     `inference` / `inference_callbacks` — supply callbacks that are
     inert/erroring-but-classified for now and leave a clearly marked
     `Chunk 2` seam. Capture must not depend on inference.
3. **The mapping** `ConversationItem` → `lhc::intake_stream::MessageEventInput`.
   This is the heart of the chunk. Target vocabulary is closed —
   `EVENT_KINDS` (9): `user_prompt`, `assistant_text`, `assistant_thinking`,
   `runtime_note`, `model_change`, `thinking_level_change`, `tool_call`,
   `tool_result`, `turn_end`. Payload shapes are in
   `packages/lhc-rs/src/intake_stream/mod.rs` (`TextPayload`,
   `ModelChangePayload`, `ThinkingLevelChangePayload`, `ToolCallPayload`,
   `ToolResultPayload`, `TurnEndPayload`) and are `deny_unknown_fields`.
   - **Exhaustive `match` over every host enum** (`ConversationItem`,
     `SyntheticReason`, assistant content parts). **No wildcard `_ =>`
     arms** on host vocabularies — upstream adding a variant must be a
     compile error, not silent capture loss. (`SyntheticReason::Unknown`
     is a real variant: match it explicitly and decide explicitly.)
   - Decide and *document in a table* the mapping for every variant,
     including: `System` items, synthetic user items by reason (real user
     input vs `runtime_note`), assistant text vs `Reasoning`
     (`assistant_thinking`), `BackendToolCall` (server-side tool calls —
     these are real tool calls to LHC), `ToolResult` incl. `is_error`,
     working-directory-switch appends, and where `turn_end` is emitted.
   - Never scrape rendered terminal text. Everything comes from typed items.
4. **Idempotency keys.** Stable across persistence, replay, resume, rewind,
   retries, session forks, and process restart. Derive them from durable
   content (session/thread identity + item identity/content digest +
   ordinal), never from wall time, RNG, or in-memory counters that reset.
   `message_events` reports `BatchSkipReason::DuplicateIdempotencyKey` —
   replaying the same history twice must produce **zero** new events.
   Write the test that proves it.
5. **`replace_history` (compaction/rewind) handling.** Chunk 2 owns the
   compact bridge; in Chunk 1 `replace_history` must at minimum not corrupt
   the LHC record or double-capture. Decide explicitly, document the
   decision and its rationale, and test it.
6. **Migration/bootstrap for pre-LHC sessions.** Backfill from the existing
   `chat_history.jsonl` **without rewriting that file** — it remains the
   recovery authority until cutover is certified. Replay must be idempotent
   (same keys as live capture).
7. **Errors/telemetry.** Translate LHC `OpResult` errors into host tracing.
   **LHC failure must never break the host session** in Chunk 1 (capture is
   observational): log, disable further capture for the session if
   persistently failing, and keep the host running. Prove it with a test
   using a failing/poisoned LHC instance.

## Certification you must deliver (the chunk is not done without these)

- A **mapping table** (in the crate as rustdoc or `MAPPING.md`) covering
  every `ConversationItem` variant and every `SyntheticReason`.
- **Golden event transcripts** under
  `crates/lhc/grok-lhc-host/tests/goldens/` — this directory arms layer 3
  of `scripts/check-lhc-hooks.sh`, so it must exist and its tests must pass
  under `cargo test --manifest-path crates/lhc/grok-lhc-host/Cargo.toml`.
  Cover every event kind you emit and every variant in the mapping table.
- Tests for: restart, replay, session fork, rewind, idempotency,
  concurrency, and **no loss or duplication under injected crash** (drop
  the adapter mid-batch and re-run).
- Test proving **host default behavior is unchanged with `GROK_LHC` unset**.
- `cargo check`/`cargo test` green for `grok-lhc-host`; the host workspace
  still builds (`cargo check -p xai-grok-shell`) and `cargo fmt --check` +
  `cargo clippy` clean for files you touched.
- `scripts/check-lhc-hooks.sh` green: sentinel 3/3, compile ok, golden
  smoke ok (no longer SKIP).

## Reporting rules (Lee's standing rule, hard)

Your final report names your position against the **full project**: "Chunk
1 of 3, Phase 3 of 3 — unit ~16 of 18". Any "done" states in the same
sentence what remains and whether it is the larger part. Do not report a
chunk's completion as the project's.

Also report explicitly: files changed (full list), every mapping decision
you had to make and why, anything you could not do and why, and any place
where you were tempted to touch the vendored port or a core file outside
the enumerated three.

## Escalate (stop and report, do not work around)

- A seam above has moved or vanished at the current tip.
- A needed core touchpoint beyond the enumerated three.
- Any need to change the vendored `lhc` crate's behavior or public shape.
- Genuine ambiguity where two defensible mappings would behave differently.
