# Schema v5 — turn-scoped host facts

Design brief for adding three host-observed facts LHC currently discards:
provider token usage, turn outcome, and wall-clock turn timing. Origin:
the codex-lhc orchestrator's ask (`lhc-docs/lhc-schema-ask.md` in the
codex fork), which arose from working out what a Codex rollout file could
be regenerated from an LHC thread. Verified against grok-build: both
hosts observe all three facts on their own wires today and drop them.

Status: DESIGN — awaiting Lee's review. Nothing below is implemented.

## Read first

`docs/onboard/01-core-concepts.md` and `02-domain-design.md`. The design
below follows from two rules stated there: durable facts enter through
intake as events (the canonical record) and project outward; and hosts
supply facts they observe — LHC never computes what a host already knows.

## The three facts

1. **Provider token usage** — the provider's own reported counts
   (input / cached / output / reasoning etc.), per model call. Distinct
   from `message.token_estimate`, which is LHC's own estimate for band
   sizing and stays untouched.
2. **Turn outcome** — completed vs aborted, with an optional reason.
   Today `turns.status` is `open|closed` only; an interrupted turn is
   indistinguishable from a finished one. Aborted-turn content means
   something different to derivation.
3. **Wall-clock turn timing** — host-reported start/end times, distinct
   from `event.recorded_at` (capture time, an approximation).

## Design decisions

**D1 — No new event kinds. Facts ride existing events as optional
payload fields.** The event vocabulary (9 kinds) stays closed; every
exhaustive match in every port and host is untouched.

- `turn_end` payload — today validated as *mandatory empty*
  (`intake-stream/internal/validate.ts:152-156`) — becomes "may carry
  only these optional fields": `outcome` (`"completed" | "aborted"`),
  `outcomeReason` (string), `startedAt`, `endedAt` (ISO timestamps,
  host-reported). Empty stays valid: hosts that send nothing keep
  working, and their turns simply carry unknowns.
- `assistant_text` payload gains optional `providerUsage`: the
  provider's usage object **verbatim** (JSON object, not a fixed column
  set). Per model call, attached to the event that ends that call —
  which is exactly when both hosts hold it (Codex
  `ResponseEvent::Completed`, grok's completion path). Provider shapes
  differ (cached_input, cache_write, reasoning_output…); verbatim JSON
  preserves fidelity without per-provider schema churn. LHC never
  interprets it — it is host fact, stored and returned.

**D2 — `turns.status` is untouched. Outcome is a new, separate column.**
Lifecycle (`open|closed`) and outcome (how it ended) are different
axes. Keeping them separate means zero consumers of `status` change,
the CHECK constraint stands, and outcome is nullable where NULL means
*unknown* — which is the honest value for every pre-v5 turn and for
hosts that don't report it.

New nullable columns on `turns`: `outcome` (`CHECK (outcome IN
('completed','aborted') OR outcome IS NULL)`), `outcome_reason` TEXT,
`started_at` TEXT, `ended_at` TEXT. Projected at `closeTurn` from the
`turn_end` payload.

**D3 — Usage is stored per call, never rolled up.** New nullable column
on `message`: `provider_usage` TEXT (the verbatim JSON), populated on
assistant messages whose source event carried it. Turn-level totals are
a SUM at read time — derivable, therefore not stored. The per-call vs
per-turn distinction the ask flags is resolved by construction: the
record holds calls; consumers aggregate.

**D4 — Migration v4→v5 adds the nullable columns and backfills
nothing.** Old rows keep NULL in every new field — the facts were never
recorded; inventing values would be fabricating record. No downgrade:
once a file is v5, v4 builds refuse it (existing version gate).
Fork-rollback consequence: flag-off disables LHC entirely, nothing
user-facing breaks — bump host pins in an order you'll keep.

**D5 — Read surfaces return the new fields.** `turns` reads expose
outcome/timing; `messages.show`/`list` expose `provider_usage`. The
session/thread view is NOT extended in this change — regeneration
consumers (the rollout-rebuild work that motivated this) read via the
messages/turns surfaces, which is the right altitude for host facts.

## Propagation ledger

| Port | When | Notes |
|---|---|---|
| `packages/lhc` (TS) | **Together with Rust — leads.** | TS is the conformance oracle; a Rust-only v5 suspends byte-parity certification. |
| `packages/lhc-rs` | **Together with TS.** | Regenerate conformance fixtures at v5, including a migration leg: same v4 fixture thread migrated by TS and by Rust must produce byte-identical files. |
| `packages/lhc-py` | Same batch, rides behind. | Test suite mirrors TS's — port the TS test changes while fresh. Hermes host untouched (fields optional). |
| `packages/lhc-convex` | Same batch. | Gets a consumer today (Lee's specs in progress) — must start life on v5, not migrate under its first user. Convex schema evolution, not the SQLite ladder: new optional fields on `turns`/`messages` tables in `convex/schema.ts`. |
| codex-lhc / grok-build pins | After the batch certifies. | Pin bumps; the tripwire pin-drift check reports lag automatically. Host wiring to *send* the new payload fields is each fork's own follow-up. |

## Explicitly out of scope

- Carrying the host display stream in full (the codex ask marks this
  open, not asked).
- Codex's `ThreadRolledBack` wiring gap — host-side use of existing
  delete/visibility primitives, not a schema matter.
- Turn-level usage rollup columns (derivable), session-view exposure
  (D5), and any change to `token_estimate` or band sizing.

## Certification bar

Standard: gate green in every touched port; prompt/goldens untouched;
new conformance legs — v5 fresh-thread byte-parity (TS vs Rust) and
v4→v5 migration byte-parity (TS vs Rust); py suite green with the
ported test deltas; convex suite green. Fields must round-trip verbatim
(intake payload → storage → read surface) in every port, asserted
byte-level for `provider_usage`.
