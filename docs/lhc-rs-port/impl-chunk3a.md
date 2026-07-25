# Chunk 3A — product wiring, configuration, diagnostics, rollout safety

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.** Chunk 3 is the only chunk
that produces something Lee can actually use; 3A is its first half. 3B (live
certification) follows and is what signs Phase 3 off.

Do not start until told Chunk 2 is accepted and committed.

## Standing rules (unchanged, binding)

- Work in `/srv/work/grok-build`, branch `lhc`. Leave changes **uncommitted**;
  the orchestrator commits.
- Vendored `crates/lhc/vendor/long-horizon-context` is **read-only**. Never
  modify it, never reshape certified LHC semantics to fit the host — adapter
  translation only.
- **C2:** report out-of-scope findings, do not fix them.
- No wildcard `_ =>` arms over host enums at the seam — vocabulary drift must
  become a compile error.
- Any commit touching an `LHC-HOOK` line updates, **in the same change**: the
  sentinel total in `scripts/check-lhc-hooks.sh`, FORK.md's touchpoint
  inventory, and the `patches/` series.
- **Off-by-default is still the law.** With `GROK_LHC` unset the host must be
  behaviorally identical, with no added per-turn work. Every surface below is
  inert when LHC is off.

## Enumerated touchpoints for this chunk — this is the authorized set

Chunk 3 adds core touchpoints, which is expected and in scope per the Phase 3
brief ("status/inspect/repair surfaces, diagnostics"). **These are enumerated
here so they are authorized rather than ad-hoc.** Anything beyond this list is
an escalation, not a decision:

1. **`BuiltinAction`** (`session/slash_commands.rs:810`) — one new variant for
   the LHC status/inspect surface, plus its parser entry, its telemetry name
   arm (`:885`), and its mutating-flag arm (`:920`). The enum is matched
   exhaustively in several places; adding a variant is a compile-guided edit,
   which is the point.
2. **`slash_exec.rs`** (`:82`, alongside `BuiltinAction::ContextInfo`) — the
   handler that renders it.
3. **Config** (`config/mod.rs`) — one `LhcConfig` section following the
   existing sectioned pattern (`MemoryConfig`, `ToolsConfig`, …), with the
   same `Sourced`/precedence conventions the neighbours use.

Hooks 1–6 are unchanged. If you find yourself needing a seventh runtime hook,
**stop and report** — that is a scope question.

## What to build

### A1 [blocking] Configuration

Today LHC is driven entirely by env vars: `GROK_LHC`, `GROK_LHC_ROOT`,
`GROK_LHC_COMPACT`, `GROK_LHC_COMPACT_EXPERIMENTAL`, `GROK_LHC_EQUIVALENCE`,
`GROK_LHC_INFERENCE_MODEL`. That is right for a dev flag and wrong for a
product.

Add an `LhcConfig` section to the host config with, at minimum: enable/disable,
storage root, compaction mode (shadow/replace, with `replace` still requiring
the experimental gate), inference model override, and equivalence
instrumentation. Follow the neighbouring sections' conventions exactly —
serde shape, defaults, `Sourced` provenance, and the reloader/watcher
behaviour if those apply to sibling sections.

**Precedence must be explicit and documented**: env var vs config file vs
default — decide which wins, state it in MAPPING.md, and test it. Env vars
must keep working; they are what every existing test and the Chunk 2 gates
use. Default remains **off**.

### A2 [blocking] Status / inspect surface

A user must be able to answer, without reading logs: *is LHC on, what mode,
where is its storage, how big is it, when did it last compact, and is it
healthy?*

Add the new `BuiltinAction` variant and its handler. It should report at
least: enabled/disabled and how it was set (env vs config); compaction mode;
storage path and size; session id and whether capture is active for it; event
counts and the last recorded event; last compaction (when, tokens before →
after); LHC view status (`ViewStatus` — pending/failed derivations); and the
equivalence counters from `equivalence_snapshot()` when armed.

Design it so **the active context engine is unambiguous** — a user must never
have to guess whether the native or LHC path built their request. That is a
named requirement in the Phase 3 done-definition.

When LHC is off, the surface says so plainly and does no work.

### A3 [blocking] Diagnostics and repair

- A **health check** the status surface can call: storage reachable, schema
  present, no failed derivations, worker alive, no unbounded backlog.
- A **repair/inspect path** for the failure modes we know exist: failed
  derivations, a stale or corrupt view snapshot, an orphaned session
  directory. Repair must be explicit and user-invoked — never automatic and
  never destructive without saying exactly what it will delete.
- Structured diagnostics on the enabled path only.

### A4 [blocking] Privacy, redaction, telemetry

- **No silent remote upload of LHC SQLite.** Named requirement in the Phase 3
  brief. Verify nothing in the telemetry or memory paths can ship LHC storage
  or its contents off-box, and state in MAPPING.md what you checked.
- Telemetry consistent with existing conventions (`xai_grok_telemetry::events`
  — follow how `SlashCommandUsed` and `MemoryFlushTrigger` are emitted).
  Counts and health, **never conversation content**.
- If the host has redaction conventions for stored conversation data, LHC
  storage follows them; if it does not, say so rather than inventing one.

### A5 [blocking] Rollout safety

The Phase 3 brief requires all four:

- off-by-default or an agreed cohort gate — **off-by-default, already true**;
- **per-session opt-in and explicit fallback** — a user must be able to run one
  session with LHC and the next without, and to turn it off mid-session if it
  misbehaves. Verify what actually happens when LHC is disabled mid-session and
  make that path coherent;
- **no irreversible migration before validation** — nothing may rewrite or
  delete native session state such that turning LHC off loses history. Note
  that Chunk 2's write-back *does* rewrite the native conversation on compact;
  state plainly in MAPPING.md what is and is not recoverable after that, and
  whether the pre-compaction body survives anywhere (`updates.jsonl`, LHC's own
  event log). If something is genuinely unrecoverable, that is a finding —
  report it;
- **observable health and a documented rollback procedure** — FORK.md gets a
  rollback runbook a fresh agent can execute: how to turn LHC off, what state
  remains, what to check afterward.

### A6 [major] Migration and storage discovery

- Discovery: where LHC storage lives per session, how it is found on resume,
  what happens on a **first run with LHC newly enabled on an existing session**
  (the interesting case — native history exists, LHC has nothing).
- Enabling LHC mid-session must not corrupt or double-record. Test it.
- Disabling and re-enabling must be coherent.

## Certification for 3A

Everything above gets tests in the adapter's certification suite where it can
be reached from there, and host-side tests where it cannot. Specifically:
config precedence; the status surface with LHC on and off; health check
against a healthy and a deliberately broken store; per-session opt-in;
enable-mid-session; disable-mid-session; and the off-by-default no-op
assertion.

State honestly which of these are adapter-level simulations rather than live
host behaviour — 3B's live certification is where those get their real check,
and it needs to know what to look at.

## Report

Position against the full project (Chunk 3 of 3, Phase 3 of 4, unit 18 of
~22). Cover each of A1–A6: built / not built and why. Name the touchpoints you
added against the enumerated list above, and confirm the sentinel, FORK.md
inventory and `patches/` series were updated together. State the config
precedence rule you chose. List what is adapter-simulated versus
host-verified. Flag anything that pushed you toward the vendored port, a
seventh hook, or a change in Chunk 1/2 semantics.
