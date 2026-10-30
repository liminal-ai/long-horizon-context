# Compact-continuation parity fixtures (v1)

Tracked, versioned fixtures for LIM-60. The TypeScript implementation must
produce the `expected` decision for every case.

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
  "inputValidation": "accept" | "reject",
  "input": { /* CompactContinuationInput shape (valid only when accept) */ },
  "expected": { /* CompactContinuationDecision */ }
}
```

`inputValidation` is a closed two-value vocabulary:

| Value | Meaning |
| --- | --- |
| `"accept"` | `input` must pass `validateCompactContinuationInput` (legal `CompactContinuationInput`). |
| `"reject"` | `input` is intentionally invalid; validation must fail. |

Parity covers **both** input validation and the total oracle. A rejected input
may still carry `expected` total-oracle output so direct typed callers that
evaluate without re-validating pin residual refuse behavior.

`expected` is the full pure-oracle output: `outcome`, `terminalState`,
`transitionPath`, `effects`, and `receipt` (including `residual`, skip/refuse codes).

## Manifest schema

```json
{
  "contractVersion": "1.0.0",
  "contractId": "lhc.compact_continuation",
  "description": "string",
  "cases": [
    {
      "file": "cases/<name>.json",
      "name": "string",
      "coverage": ["tag", "..."],
      "inputValidation": "accept" | "reject"
    }
  ],
  "requiredCoverage": ["tag", "..."]
}
```

Each manifest entry's `inputValidation` must match the corresponding case file.
Consumers branch on this field for validation expectation, not on coverage-tag
strings.

## Closed-shape inputs

v1 legal inputs (`inputValidation: "accept"`) are **closed-shape**: unknown
fields on every contract-owned input object and discriminated-union branch are
rejected. Cases marked `"reject"` document intentional validation failures
and are not required to be valid `CompactContinuationInput`. Input closure is
mandatory for accepted inputs.

## Regenerating

From `packages/lhc` after editing the pure decision function:

```bash
pnpm exec tsx scripts/gen-compact-continuation-fixtures.mjs
```

Only regenerate when the contract decision table intentionally changes.
With an unchanged table, regeneration must leave a clean git diff.
Independent behavioral tests in `test/compact-continuation-contract.test.ts`
are the authority for corner outcomes; fixtures alone are not.
