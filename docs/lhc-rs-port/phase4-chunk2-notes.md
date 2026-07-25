# Phase 4 / Chunk 2 — pre-flight notes (census + seam re-verification)

Position: **Chunk 2 = unit 21 of 22.** Chunk 1 (unit 20, capture) is in fix
round 1 and NOT accepted. This file is groundwork gathered while that round
runs; nothing here is a licence to start building. Chunk 2's binding law 3
requires the fail-open / full-conversation-consumer census **at chunk start,
not when one bites** — this is that census, opened early.

Seams re-verified at tip `322d5b96cf` (2026-07-25) unless noted.

## 1. Write-back is structurally correct in this host (law 1 / law 2)

This is the material finding, and it is good news — Codex does not have the
two-truths disease Grok Build's Chunk 2 hit.

- **All three native compaction arms already route through the same
  replacement API**: `compact.rs:373` (local), `compact_remote.rs:284`,
  `compact_remote_v2.rs:306`, plus `session/mod.rs:3672` (auto-compact).
  An LHC arm calling `replace_compacted_history` is therefore identical in
  kind to the native arms, not a parallel path.
- **The threshold-untrips requirement is satisfied by construction**:
  `state/session.rs:114 replace_history` calls
  `self.auto_compact_window.clear_prefill()`. So the auto-compact window
  state observes an LHC replacement exactly as it observes native
  compaction. Law 2 still requires a **test** proving compact-once →
  counter drops → no re-trigger next turn; it is no longer a design risk,
  only a coverage obligation.
- Rollout persistence is `RolloutItem::Compacted(CompactedItem)` carrying
  `replacement_history`, persisted verbatim — the certification-friendly
  level named in the Phase 4 brief.

## 2. Compaction dispatch ladder — shape unchanged, migration watch still live

`tasks/compact.rs::run`, order today:

1. `Feature::TokenBudget` → `compact_token_budget::run_manual_compact_task`
   (early return);
2. `should_use_remote_compact_task(provider)` →
   - `Feature::RemoteCompactionV2` → `compact_remote_v2`
   - else → `compact_remote`
3. else → local `compact::run_compact_task`.

Matches the brief's recorded order (TokenBudget → remote_v2 → remote →
local). **RemoteCompactionV2 has not yet eaten the local dispatch sites** —
the migration risk the brief flags is still pending, not realised. Re-check
this ladder's shape at **every** sync; if local dispatch shrinks toward
deprecation, that is a stop-and-surface, not a redesign to improvise.

Note the LHC arm must decide its position relative to `TokenBudget`, which
returns early and would bypass an arm placed below it.

## 3. Inference seam — zero patch, confirmed

`core/src/lib.rs:182-183` exports `pub use client::ModelClient;` and
`pub use client::ModelClientSession;`. The audit's re-export/reimplement
workaround is obsolete, as the brief said. LHC's `ModelCall` consumes these
directly.

**Auth-lane question remains a Lee decision** (FORK.md scheduled-verification
table, "Chunk 2 start"): derivation calls ride the user's auth lane, so under
a ChatGPT plan they spend plan quota and may look anomalous. Options to put
to Lee: dedicated API-key lane for derivation vs. accepting plan-quota spend.
Do not decide this in-flight.

## 4. Full-conversation consumer census (law 3) — first pass

Consumers that read whole-conversation state outside the request builder, to
confirm each rides native state (which write-back makes true by default —
verify, do not assume):

| Consumer | Site | Status |
|---|---|---|
| Resume | `InitialHistory::Resumed` (`thread_manager.rs:874,1122,1164`) | Replays persisted rollout; rides native state |
| Fork (full history) | `SpawnAgentForkMode::FullHistory` (`tools/handlers/multi_agents_v2/spawn.rs:66,205`) | Forks whole history to a subagent — **highest-risk consumer**; a fork taken after an LHC compact inherits the LHC body |
| Fork (last-N turns) | same file, `fork_turns` numeric | Turn-counted slice of native state |
| Cleared / New | `InitialHistory::{New,Cleared}` | No history |
| Manual `/compact` | `tasks/compact.rs::run` | Is itself the ladder |
| Auto-compact | `session/mod.rs:3672` | Routes through the same replacement API |

Still to enumerate at Chunk 2 kickoff (not yet audited): review flows,
inter-agent communication replay, anything `/btw`-shaped, and the
`compact_remote_v2` prefill path. **This census is incomplete and must be
finished before the bridge is built.**

## 5. Carry-over facts that also settle Chunk 1 questions

- `InitialHistory` is a **typed** discriminator for replay
  (`New | Resumed | Forked | Cleared`). This is the host signal the Chunk 1
  fix brief (F1) points the implementor at for distinguishing "host is
  replaying history it already gave me" from "the user said the same thing
  twice". It exists; the F1 redesign is grounded, not speculative.
- `replace_compacted_history` does **not** route through
  `record_conversation_items` (verified twice, independently). LHC write-back
  will not re-enter capture — but Chunk 2 must re-verify this at its own tip,
  since a change here would silently break Chunk 1's idempotency guarantees.

## 6. Front-loaded unknown — band-shape tolerance eval

Unchanged and still **blocking the bridge** (FORK.md scheduled-verification:
"Chunk 2, BEFORE the bridge is built"): whether Codex models tolerate
band-shaped replacement history, given they are tuned for their own
compaction-summary shape. Cheap harness: feed band-shaped history through
`replace_compacted_history` on a throwaway session, judge coherence of
continued turns. If intolerant, shape-adapting the band render is a **Lee
decision**, not an improvisation.
