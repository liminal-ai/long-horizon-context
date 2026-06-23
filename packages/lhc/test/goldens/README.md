# Selection goldens (Epic 03 Story 2, G1–G3)

Committed expected arrangements for the band-selection walk (tech design
§Deterministic Algorithms), consumed by `test/view-select-golden.test.ts`.
Each golden pins the exact arrangement a compact must produce on the Story-0
fixture under explicit params: subject ids per band, form used, compact point,
covered_from, and gaps.

**Goldens are immutable once committed.** An implementation that disagrees
with a golden is wrong until the *design rule* is shown wrong — that takes the
deviation process, not a golden edit. The expected values were hand-derived
from the design's rules (rules 1–6, the pinned ≤/newest-first/newest-member
tie-breakers) against the fixture's deterministic token costs.

Regenerated once under impl-lead ruling
`02-smart-compact-story-run-001-ruling-013`: the first commit's goldens
encoded extra-rule selection behavior (smooth-obligate inclusion,
partial-chunk retreat, suppressed brief loner); these goldens encode the
literal rules.

| File | Case | Rule under test |
|------|------|-----------------|
| `g1-proportions.json` | G1 | shares → bands across the full gradient |
| `g2-edge-inclusion.json` | G2a | entry exactly filling the remainder is included (≤) |
| `g2-edge-exclusion.json` | G2b | one token under the exact fill → excluded, band stops |
| `g3-oversized-loner.json` | G3 | oversized entry on an otherwise-empty band represents alone |
| `boundary-g1-trajectory.json` | Boundary G1 (Epic 03 Story 4, re-cut by Epic 05 Story 6) | advance trajectory under the turn-end trigger: over-max check at turn close only, whole-turn oldest-first eviction with the peek-ahead stop, newest-closed-turn protection, mid-turn batches never move, never-backward across batches |

## Regeneration (only with a granted deviation)

The actual arrangement for any params can be printed by running the golden
suite with `GOLDEN_DUMP=1`:

```
GOLDEN_DUMP=1 npx vitest run test/view-select-golden.test.ts
```

Each case logs its actual `{compactPoint, coveredFrom, arrangement, gaps}`
JSON; verify the new values against the design rules by hand before replacing
a file, and record the deviation that made the old golden wrong.
