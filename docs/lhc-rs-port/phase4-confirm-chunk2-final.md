# Phase 4 / Chunk 2 — FINAL confirmation (resumed session)

Resume your own session. **Narrow. This is the acceptance round.**

Since your last report, rounds 4–6 landed. You have not seen them. Check
these and regressions in changed files only. Do not re-audit the chunk.

## What changed

**I1 (your R2 — marker inverting the compactor).** The model-visible
`runtime_note` is now a constant-size summary (8 scalar fields). Digests and
host ids moved to a durable record LHC does not render into
`LlmRequestContext`. `RUNTIME_NOTE_MAX_CHARS = 1024`.

**I2 (your R1 — crash window).** The derived record is now written in the
**same durable operation** as the body install (`replace_compacted_history` /
`CompactedItem`), not at process scope. `seed_last_lhc_durable_from_rollout`
re-seeds on resume/fork.

**J1 — real inference is now the production default.**
`CODEX_LHC_LIVE_INFERENCE` is deleted as a switch. Production always uses the
real `ModelClient` bridge; on client-resolution failure it returns
`Unavailable` and falls open to the native ladder. Deterministic callbacks are
test-only, via explicit constructors.

**J2 — model pinned.** `LHC_DERIVATION_MODEL = "gpt-5.6-luna"` for all four
derivation callbacks, effort `low` (luna's catalog has no `none`; the
fallback is logged). Resolved through `models_manager`; never falls back to
the turn model.

**K1** — the `include_str!` grep test is deleted, replaced with a behavioural
test.

## Verified by the orchestrator — do NOT re-derive

- **I1 mutation:** full marker JSON restored to the note → 20-round test fails
  (`runtime note must be bounded, got 4156`). Restored, green.
- **Production probe, 2 real compacts:** archive `before=160 mid=161
  after=162` — markers only, no body re-ingest (was 191 pre-fix).
- **Full `codex-core` lib suite:** 2115 passed. Two failures run down —
  `post_sampling_token_estimate…` passes in isolation (tracing global-state
  ordering artefact); `config_schema_matches_fixture` was a **real fork
  defect since Chunk 1** (the `lhc_capture` flag adds a config schema field;
  the fixture was never regenerated). Fixed, added to patch 0003, and a new
  tripwire layer `upstream-schema` now runs upstream's own test.
- **Vendor drift:** a workspace-level `cargo fmt` had reformatted 137 vendored
  LHC files (imports only). Restored to pin `3663839`; tripwire green.
- **Patch 0007** regenerated; `patch-repro` green.
- Tripwire: **13 layers, ALL GREEN**.

## Where I want your attention

1. **J1's fail-open.** Real inference is now default. If the model client is
   unavailable mid-compact (auth expiry, network, rate limit), does the arm
   reliably reach the native ladder — or can it hang, retry forever, or
   install a partial body? This is the newest production risk in the chunk.
2. **J2's pin.** Can any path still ride the user's turn model? Confirm all
   four callbacks, not one.
3. **I2's durability.** The derived record and the body are claimed to be one
   durable write. Verify they cannot be separated by a crash.
4. **I1.** Confirm bookkeeping is genuinely absent from what the model sees,
   not merely smaller.

## Acceptance bar

Unchanged. Body from LHC's compaction; law 1 equality; law 2 real reduction;
both ladders hook-sensitive; resume/fork import-or-refuse by identity; gate
fails closed; fail-open bounded in size and time; tripwire green; patches
apply **and** reproduce.

**Not blocking:** documentation, naming, inventory rows, module length,
change-set size, warnings, test metadata. Trailing list only.

**This is the acceptance round.** If the bridge is sound, say so plainly —
that is the expected outcome. Only something **product-wrong** justifies
another round.

## Rules

Your own tree (refreshed in place; session and `.git` intact). Mutate freely,
restore exactly, verify the tree matches pre-check.

**Do not run workspace-level `cargo fmt`** — it reaches into the vendored
submodule and dirties the pin. Use `-p codex-lhc-host`.

Do not commit or push. You never see the other lane's report.

## Report

Short. (1) I1/I2/J1/J2/K1 status; (2) the four attention items;
(3) regressions with `file:line` + scenario + severity; (4) mutation outputs;
(5) plain verdict — sound or not; (6) trailing non-blocking; (7) coverage.
