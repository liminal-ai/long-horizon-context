# Compact-continuation contract v1

Provider-neutral state machine for **LHC-owned context relief at a settled model-turn seam** when agentic work continues across a compact boundary.

| Field | Value |
|---|---|
| Contract version | `1.0.0` (`COMPACT_CONTINUATION_CONTRACT_VERSION`) |
| Stable turn-end reason | `context_compact_continue` |
| Marker kind | `lhc.compact_continuation` |
| Story | LIM-60 (define + fixtures); runtime evaluator = LIM-61 |
| Module | `packages/lhc/src/shared-tech/compact-continuation/` |
| Parity fixtures | `packages/lhc/fixtures/compact-continuation/v1/` |

## What this is

- A **pure** decision function (`decideCompactContinuation`) over an explicit input bag.
- Versioned **JSON fixtures** encoding expected transitions, effects, and receipts for TypeScript and Rust parity.
- Structural validators for inputs, receipts, and decisions.

## What this is not

- Not live thread I/O, not compact assembly, not host write-back (LIM-61+).
- Not the older research “open-turn relief / prune ladder only” design. Owner rulings below win.

## Settled owner rulings (normative)

1. **Provider-reported input context** is the only upper-trigger base. Claude: `input + cache_creation + cache_read`. LHC estimates never replace a missing provider measurement.
2. **LHC rendered-history tokens** are the compact lower target. Upper and lower use different accounting domains.
3. **Next-request pressure** = last provider measurement + a **source-labelled** estimate of messages captured after that request. The estimate is never relabelled as provider usage.
4. Evaluate only at a **settled seam**: response complete, requested tools settled, capture flushed, before the next provider request. **Never** mutate inside a transport retry.
5. **Below trigger** → continue normally.
6. **Above trigger + pending correlated tool-result** → keep the canonical agentic turn open; compact older closed history; preserve the current tool call/result pair verbatim in the tail; **no** continuation prompt.
7. **Above trigger + active non-tool work** → force canonical `turn_end` reason `context_compact_continue`; compact; open **exactly one** continuation turn; serve typed marker `lhc.compact_continuation` (model-visible, LHC inspect/retrieval-visible, **not** normal user chat). Hosts that cannot mirror the typed item may inject transiently while preserving the canonical boundary and cause.
8. **Normal work completion** closes normally and creates **no** empty continuation turn.
9. Missing/failed derivations **degrade fidelity** but do not block a structurally valid compact. Lower bound is a **target**, not a success gate.
10. **Refuse** only when no structurally valid provider request can be produced/installed, or required capture/identity/correlation invariants cannot be proven.
11. **One writer** at a seam (LHC vs native). No silent native mid-turn fallback.
12. Receipts/cause are durably inspectable but **not** ordinary user chat.
13. Codex: full state machine. cc-lhc: later capability-limited governance — **no false parity** in this contract.
14. Stable reason string: `context_compact_continue`.

## Transition order

See `COMPACT_CONTINUATION_TRANSITION_ORDER` in `contract.ts`. Short form:

1. Seam eligibility (incl. transport-retry ban)
2. Input-epoch stability
3. Writer claim
4. Capture / identity / open-turn / tool correlation
5. Provider-usage authority
6. Pressure evaluation
7. Continuation branch
8. Compact assembly (degraded derivations allowed)
9. Install / preserve / open continuation
10. Receipt + writer release

## Outcomes

| Outcome | Meaning |
|---|---|
| `continue_normal` | No compact; work continues |
| `compact_preserve_tool` | Compact closed history; same agentic turn; tool pair verbatim |
| `compact_continue_turn` | Force `context_compact_continue`; open one continuation turn + marker |
| `normal_complete` | Work done; no empty continuation turn |
| `degraded_compact` | Structurally valid compact with fidelity degradation |
| `no_reduction` | Compact ran; no useful reduction; not a hard failure |
| `skip_seam` | Safe skip (epoch change, transport retry) |
| `refuse` | Hard stop; see refuse codes |

## Fixtures

JSON files under `packages/lhc/fixtures/compact-continuation/v1/cases/`. Each case:

```json
{
  "name": "…",
  "contractVersion": "1.0.0",
  "description": "…",
  "input": { …CompactContinuationInput },
  "expected": { …CompactContinuationDecision }
}
```

`manifest.json` lists case files and the required coverage tags.

## Parity

- TypeScript: `packages/lhc/test/compact-continuation-contract.test.ts` loads every case, runs `decideCompactContinuation`, and asserts exact JSON equality.
- Rust (LIM-62): consume the same JSON directory; re-implement `decide` against `contract` types; golden-compare receipts.

## Host capability

`policy.hostCapability` is `full_state_machine` | `capability_limited`. The pure decision table is the full machine. Capability-limited hosts (cc-lhc) must not claim effects they cannot perform; that adapter honesty is LIM-64, not a second decision table here.
