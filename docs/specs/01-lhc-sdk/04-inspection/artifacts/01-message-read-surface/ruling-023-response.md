# Ruling: 01-message-read-surface-story-run-001-ruling-023

Decision: strict-read-purity-supersedes-first-touch-recovery

Rationale (impl-lead, spec-backed):
- Epic 04 Story 1 Architecture-Risk Tests require read-only drift protection: before/after observable-state snapshots must stay equal for `listMessages` and `show`.
- Epic 04 test-plan architecture-risk row: "Inspect quietly writes" — the read-only delta assert wraps every new read operation; reads that trigger catch-up work would violate it structurally.
- AC-1.4 (Epic 04) establishes the pure-read contract for the inspection surface family; messages reads are the drill-down floor of that surface.
- Recovery belongs to explicit drain/work execution by owning domains (domain-design: repair is a surface call; never run repair in the hot read path).

Follow-up routing: update the stale `packages/lhc/test/red-manifest.json` (SV-01-004) via quick-fix, then re-verify. `pnpm verify` remains the story gate; green-verify's red-manifest staleness must be cleared per house discipline.
