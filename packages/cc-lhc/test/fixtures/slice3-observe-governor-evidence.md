# Slice 3 — observe-only governor evidence

Date: 2026-08-10 · Claude `2.1.226` · **No commit** · **Not self-accepted**

## Frozen executable

Root: `/tmp/cc-lhc-slice3-1786321762`

Manifest OK after freeze; not rebuilt for the exhibit.
Launcher: self-contained `bin/cc-lhc` → frozen `dist/bin.js`.

Coherent audit: `/tmp/cc-lhc-slice3-1786321762/s3-exhibit-audit.json`

## Session overrides (not persisted)

- `--lhc-auto-compact=on`
- `--lhc-lower-bound-tokens=100`
- `--lhc-upper-bound-tokens=5000`
- `--lhc-min-runway-tokens=50`

## Governor observe record (wrapper.log)

Decision: **would_compact** · `wouldMutate=false` · `observeOnly=true`

Provider context (trigger authority):

| component | tokens |
|-----------|--------|
| input_tokens | 2 |
| cache_creation_input_tokens | 12894 |
| cache_read_input_tokens | 15616 |
| **total** | **28512** |

Total = sum of components; total ≥ upperBound 5000.

This is **not** LHC tail/view size (no compact; `thread_view_band` count = 0).

## No mutation

- wouldMutate false
- retrieval impressions: 0
- thread_view_band rows: 0
- no rebuild/respawn log lines
- single fresh thread; capture healthy

## Deterministic gates (worktree)

| Gate | Result |
|------|--------|
| Typecheck lhc + cc-lhc | green |
| LHC 63/539/31skip | green |
| cc-lhc 57/514 | green |
| governor unit tests 38 | green |
| doctrine ×3 | green |
| git diff --check | clean |

## Design notes

- Built-in defaults: lower 240k / upper 500k / native backstop 1M / autoCompact off / profile continuation.
- Slice 3 always observe-only; autoCompact is intent only.
- Intermediate prune off; never executed.

## Artifact hashes

- binJs: `f68426146b6d885029c141588e164536b1e0b935271d5553a42a551e1423267e`
- governorDecide: `8fbe0e9df3bd32de995e99660f197219fcb2674ddedfe32b354bfa12692d3f6f`
- governorConfig: `a41addf5bfdb48ee154edbc01e23632f9fc5d9e02da6027598ef1df16a6fd9ff`
- wrapperRun: `a77086ae83e31e9439f16331c086ba32b5ae0df19ca5d7404c729b75e71ce5a4`
- launcher: `d225f46f4f13b435d012aad50782c90b32c3034aedc2026624ca90122872bcfe`

Rollout lines: 10. Prompt bytes: 12526.

Status: **EVIDENCE_COMPLETE** (inspectable evidence; steward acceptance only).
