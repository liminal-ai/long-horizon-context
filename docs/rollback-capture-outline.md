# Rollback capture — problem outline

Working outline, not a design. Records a known cross-host gap and the
general shape of the fix, so it isn't rediscovered. Nothing here is
decided beyond "this needs doing."

## The problem

Hosts have rewind/undo features — Codex's rollback ("drop my last N
turns"), Claude Code's rewind, PI's equivalents. When a user rewinds,
the host's own session state forgets those turns, but nothing tells
LHC. The canonical record still holds them as normal live turns.

Consequences:

- Any projection rebuilt from the thread (compact rebuilds, session
  seeding, the planned Codex rollout regeneration) resurrects turns the
  user deliberately removed.
- The record can't distinguish "conversation continued" from
  "conversation continued after the user discarded a path" — the
  rollback itself is a fact about the thread that goes unrecorded.

This affects every host: codex-lhc (`ThreadRolledBack` markers are
applied host-side, LHC never sees them), pi-lhc, cc-lhc. Surfaced
concretely during the Codex rollout-ownership analysis
(`/srv/work/codex/lhc-docs/rollout-design-notes.md`, "Rollback" open
question), where regeneration makes the gap user-visible.

## What exists today

- Storage carries hidden flags (`deleted_at` on turns and messages) and
  read surfaces can include or exclude hidden rows.
- What's missing is the front door: no intake event kind for a
  rollback, so a host has no sanctioned way to report one. Stamping
  flags directly would be a side-channel mutation — the record wouldn't
  say why turns went hidden, who hid them, or when.

## General shape of the fix (direction, not spec)

1. **Rollback enters through intake as an event**, with provenance,
   like every other host-observed fact. Content of rolled-back turns
   stays in the record forever; the act of rolling back becomes part of
   history too.
2. **Projection stamps the hidden flags in the same transaction** as
   the event — the established hot-path pattern.
3. **Views/compaction respect visibility.** Selection and rebuilds
   exclude hidden turns (flags mostly make this free). The part needing
   real design attention: bands already built over turns that are later
   rolled back — a stored summary can describe hidden content, and the
   view layer needs a story for that (likely some form of
   re-render/invalidation; undecided).

Open design questions, deliberately not answered here: the event's
scope shape (last-N vs explicit turn/event anchors), band invalidation
semantics, interaction with chunk membership and pending derivation
work for hidden turns, whether rollback of a rollback needs to exist.

## Propagation

Same cross-port batch shape as schema v5 (design once, TS leads,
rs/py/convex follow, conformance-certified — see
`docs/schema-v5-turn-host-facts.md` for the pattern), then per-host
wiring:

- codex-lhc: `ThreadRolledBack` → the new intake event. Until then the
  rollout rework carries host markers forward as a documented stopgap.
- pi-lhc: wire its rewind path.
- cc-lhc: hardest — watch-only host, can't be told; has to detect
  rollbacks from observed session files.

## Key references

- Codex rollback mechanics: `codex-rs/core/src/session/handlers.rs`
  (marker append + reconstruction rerun),
  `codex-rs/core/src/thread_rollout_truncation.rs` (drop-newest-N
  application), and the Paginated reader's refusal to support rollback
  under bounded reads (`codex-rs/rollout/src/model_context.rs`,
  `ThreadRolledBack` forces scan-to-start).
- LHC storage flags: `deleted_at` columns and include-deleted read
  options in the messages/turns domains (all four ports).
- Where the gap bites first: Codex rollout regeneration
  (`/srv/work/codex/lhc-docs/rollout-design-notes.md`).
