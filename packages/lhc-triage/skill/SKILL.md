---
name: lhc-context-triage
description: Traverse, assess, and prepare bounded repairs for LHC agent thread context using direct records and the lhc-triage CLI.
---

# LHC context triage

Use this skill when an agent appears incoherent, context metrics conflict, compaction quality degrades, derivations stall, summaries look wrong, or an operator asks what the model is actually receiving.

## Start summary-first

1. Identify the exact host profile, session/thread id, and SQLite file.
2. Run:

   ```bash
   lhc-triage THREAD.sqlite summary
   lhc-triage THREAD.sqlite issues
   ```

3. Read current derivation and work rows as live health.
4. Treat view source-state counts as historical view-build evidence.
5. Separate canonical archive size, serving view, live tail, and provider request size.

## Drill down

List compact memories before opening full turns:

```bash
lhc-triage THREAD.sqlite summaries --type chunk-brief --state ready --limit 50
lhc-triage THREAD.sqlite summaries --type chunk-detailed --limit 50
lhc-triage THREAD.sqlite summaries --type turn --limit 50
```

Select suspicious subjects by:

- incoherent or oversized summary preview
- missing expected boundary
- failed or blocked current derivation
- degraded fallback
- empty gap
- stale provenance or unexpected version
- active work with expired lease

Then inspect one subject:

```bash
lhc-triage THREAD.sqlite show chunk c22 --max-chars 4000
lhc-triage THREAD.sqlite show turn t317 --max-chars 4000
```

Use `--json` when another agent or script will rank or compare results.

## Interpret findings

- `ready`: usable stored artifact. Quality can still be poor.
- `failed`: retry may help if the source is valid.
- `blocked`: source damage is claimed. Inspect before mutation.
- missing expected boundary: lifecycle did not establish the artifact row.
- degraded fallback: lower-quality but non-empty material may preserve coverage.
- gap: empty model-visible representation. Check whether source content is unique or duplicated elsewhere.
- historical terminal logs: audit evidence, not current backlog.

## Repair boundary

The CLI is read-only. Before repair:

1. State the exact defect and expected postcondition.
2. Take a coordinated backup, including WAL state through the host's certified method.
3. Use a public domain SDK operation.
4. Do not insert derivation or work rows with raw SQL.
5. Do not fake a source edit to provoke broad rederivation.
6. Record pre/post rows, returned operation result, versions, work state, view effect, integrity, and backup hash.
7. Verify whether a normal compact is needed to rematerialize repaired artifacts.

If no public operation owns the repair, stop and describe the missing SDK capability. Do not treat an importable internal helper as a supported repair API.

## Context-quality posture

Optimize for coherent, useful memory. Preserve canonical source and durable receipts, but do not let provenance purity prevent a bounded, sanctioned repair. Distinguish a real invariant from a diagnostic or preference.
