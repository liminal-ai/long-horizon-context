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

`expected` is the full pure-oracle output: `outcome`, `terminalState`,
`transitionPath`, `effects`, and `receipt` (including `residual`, skip/refuse codes).

## Closed-shape inputs

v1 inputs are **closed-shape**: unknown fields on every contract-owned input
object and discriminated-union branch are rejected (`deny_unknown_fields`
equivalent for Rust). Receipt closed-shape may be tightened in the Rust port
story; input closure is mandatory now.

## Regenerating

From `packages/lhc` after editing the pure decision function:

```bash
pnpm exec tsx scripts/gen-compact-continuation-fixtures.mjs
```

Only regenerate when the contract decision table intentionally changes.
With an unchanged table, regeneration must leave a clean git diff.
Independent behavioral tests in `test/compact-continuation-contract.test.ts`
are the authority for corner outcomes; fixtures alone are not.
