# Compact-continuation parity fixtures (v1)

Tracked, versioned fixtures for LIM-60. TypeScript (this package) and Rust
(`packages/lhc-rs`, LIM-62) must produce byte-identical `expected` decisions
for every case.

## Layout

```
v1/
  README.md
  manifest.json          # case index + required coverage tags
  cases/<name>.json      # one case per file
```

## Case schema

```json
{
  "name": "string",
  "contractVersion": "1.0.0",
  "description": "string",
  "coverage": ["tag", "..."],
  "input": { /* CompactContinuationInput */ },
  "expected": { /* CompactContinuationDecision */ }
}
```

`expected` is the full pure-decision output: `outcome`, `terminalState`,
`transitionPath`, `effects`, and `receipt`.

## Required coverage tags

See `manifest.json` → `requiredCoverage`. Tags map to LIM-60 acceptance:

| Tag | Meaning |
|---|---|
| `no_authoritative_provider_usage` | No provider measurement; no fabricated trigger |
| `below_trigger` | Pressure under upper bound |
| `normal_completion` | Work done above/below pressure; no empty continuation |
| `pending_tool_result_continuation` | Preserve tool pair; same agentic turn |
| `active_non_tool_continuation` | `context_compact_continue` + marker |
| `derivation_gaps_degraded` | Degrade fidelity, still valid compact |
| `lower_target_missed` | Lower target not a gate |
| `incomplete_capture` | Refuse |
| `invalid_tool_correlation` | Refuse |
| `invalid_provider_identity` | Refuse |
| `compact_install_failure` | Refuse on compact/install failure |
| `native_writer_conflict` | One writer; refuse conflict |
| `stale_epoch_or_transport_retry` | Skip seam |
| `no_useful_reduction` | Non-error `no_reduction` |

## Regenerating

From `packages/lhc` after editing the pure decision function:

```bash
pnpm exec tsx scripts/gen-compact-continuation-fixtures.mjs
```

Only regenerate when the contract decision table intentionally changes. Diff
the JSON carefully; LIM-62 ports depend on these files as the oracle.
