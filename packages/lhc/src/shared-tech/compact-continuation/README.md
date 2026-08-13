# Compact-continuation contract v1

Provider-neutral state machine for **LHC-owned context relief at a settled model-turn seam** when agentic work continues across a compact boundary.

| Field | Value |
|---|---|
| Contract version | `1.0.0` (`COMPACT_CONTINUATION_CONTRACT_VERSION`) |
| Stable turn-end reason | `context_compact_continue` |
| Marker kind | `lhc.compact_continuation` |
| Story | LIM-60 (define + fixtures); runtime stages = LIM-61 |
| Module | `packages/lhc/src/shared-tech/compact-continuation/` |
| Parity fixtures | `packages/lhc/fixtures/compact-continuation/v1/` |

## Pure-function protocol

`decideCompactContinuation` is a **whole-seam parity/receipt oracle**, not a function a runtime can call once before applying every effect.

1. LIM-61 executes stages in `COMPACT_CONTINUATION_TRANSITION_ORDER` (claim writer, optional forced boundary, compact, marker, install, …).
2. It gathers **pre-decision facts** and **attempt results** into `CompactContinuationInput`.
3. It uses this oracle to **classify** the completed seam and emit the durable receipt.

Fixtures pin oracle outputs for TypeScript/Rust parity. Do not implement host I/O here.

## Settled owner rulings (normative)

1. **Provider-reported input context** is the only upper-trigger base. Claude: `input + cache_creation + cache_read`. LHC estimates never replace a missing provider measurement.
2. **LHC rendered-history tokens** are the compact lower target. Upper and lower use different accounting domains.
3. **Next-request pressure** = last provider measurement + a **source-labelled** estimate. The estimate is never relabelled as provider usage.
4. Evaluate only at a **settled seam**. Transport retry / not-yet-settled / input-epoch change ⇒ **skip** (not refuse). Never mutate inside a transport retry.
5. **Below trigger** → continue normally.
6. **Above trigger + pending correlated tool-result** → keep the canonical agentic turn open; compact older closed history; preserve the current tool call/result pair verbatim in the tail; **no** continuation marker.
7. **Above trigger + active non-tool work** → claim writer; **force canonical `turn_end` first** (reason `context_compact_continue`); **then** compact (so the just-closed turn is eligible); insert typed marker; install. One `turn_end` on a populated turn **atomically closes that turn and opens exactly one empty continuation turn** (`turns.create`). There is **no** separate `open_continuation_turn` effect. Marker is model-visible and LHC inspect/retrieval-visible, **not** normal user chat.
8. **Normal work completion** closes normally and creates **no** empty continuation turn.
9. Missing/failed **derivations** degrade fidelity but do not block a structurally valid compact. Lower bound is a **target**, not a success gate. Fidelity degradation is classified at **compact assembly**, before install.
10. **Refuse** only when no structurally valid provider request can be produced/installed, or required capture/identity/correlation invariants cannot be proven. After a host claims a settled seam, incomplete capture / invalid identity / broken open-turn / invalid tool correlation are hard refuses **even below pressure** — they mean the record or next request is untrustworthy. An **unsettled** seam is a skip/wait, not corruption.
11. **One writer** at a seam (LHC vs native). No silent native mid-turn fallback.
12. Receipts/cause are durably inspectable but **not** ordinary user chat.
13. Codex: full state machine. cc-lhc: capability-limited — **no false parity**; decision table identical, hosts must not fabricate unsupported effects.
14. Stable reason string: `context_compact_continue`.

## Active non-tool effect order (success)

```
claim_writer → force_turn_end → compact → [degrade_fidelity] → insert_continuation_marker → install_serving_view → record_receipt → release_writer
```

Marker insertion is **canonical/persisted**. Idempotency key is
`lhc.compact_continuation:<continuationTurnId>` (unique per forced boundary,
stable across repair). Semantics: `cause=context_compacted_task_in_progress`,
`action=continue_existing_task`, `newUserRequest=false`, `waitForUser=false`.
`markerPersisted` vs `markerServed`: install failure can report
persisted=true, served=false.

**Boundary identity input:** `forcedContinuationBoundary` is
`{ applied: false }` or
`{ applied: true, continuationTurnId, forcedThisSeam }`.
Runtime forces `turn_end` first on a fresh continue-turn seam, supplies the
new turn id, then classifies via the oracle.

## Residual state after post-claim failure

| Path | Residual |
|---|---|
| Tool-preserve compact/install fail | Original agentic turn still open; prior serving view intact; no marker; writer released |
| Active non-tool compact fail after boundary | Boundary durable; markerPersisted=false; no next request; prior view intact |
| Active non-tool install fail after compact | Marker persisted not served; no install effect; prior view intact; repair recoverable |
| Install fail vs no-reduction | **Install failure always wins**; `usefulReduction` only after successful install |
| Skip | `nextProviderRequestAllowed=false` (wait/re-evaluate; does not cancel in-flight transport retry) |

**Repair/retry:** `pendingForcedContinuationBoundary` takes precedence over fresh
pressure/usage; requires `continuation.kind === "active_non_tool"`; reassert
marker by idempotency key (no duplicate boundary).

## Skip vs refuse

| Skip codes | Refuse codes (examples) |
|---|---|
| `not_at_settled_seam`, `transport_retry`, `input_epoch_changed` | `incomplete_capture`, `invalid_provider_identity`, `invalid_tool_correlation`, `open_turn_invariant_broken`, `native_writer_conflict`, `compact_failed`, `install_failed`, `no_valid_provider_request`, `unsupported_contract_version` |

## Outcomes

| Outcome | Meaning |
|---|---|
| `continue_normal` | No compact; work continues |
| `compact_preserve_tool` | Compact closed history; same agentic turn; tool pair verbatim |
| `compact_continue_turn` | Forced boundary + one continuation turn + marker |
| `normal_complete` | Work done; no empty continuation turn |
| `degraded_compact` | Structurally valid compact with fidelity degradation |
| `no_reduction` | Compact ran; no useful reduction; not a hard failure |
| `skip_seam` | Safe skip (see skip codes) |
| `refuse` | Hard stop (see refuse codes + residual) |

## Fixtures

JSON under `packages/lhc/fixtures/compact-continuation/v1/cases/`. Regenerate:

```bash
pnpm exec tsx scripts/gen-compact-continuation-fixtures.mjs
```

(from `packages/lhc`). Regeneration must leave a clean git diff when the decision table is unchanged.
