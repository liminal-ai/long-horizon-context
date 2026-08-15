# lhc-triage

Read-only CLI for agent-led traversal and context-health triage of LHC SQLite thread stores.

The CLI reads canonical records and materialized views directly. It does not depend on lhc-console API metrics. It opens SQLite with `readOnly` and `query_only`, and it never derives, enqueues, compacts, or repairs.

## Commands

```bash
lhc-triage THREAD.sqlite summary
lhc-triage THREAD.sqlite issues
lhc-triage THREAD.sqlite summaries --type chunk-brief --state ready --limit 25
lhc-triage THREAD.sqlite show chunk c22 --max-chars 4000
lhc-triage THREAD.sqlite show turn t317 --max-chars 4000
```

Add `--json` to `summary`, `issues`, or `summaries` for stable machine-readable output.

Summary types:

- `turn` — detailed turn compression
- `turn-rendering` — deterministic turn rendering
- `chunk-detailed`
- `chunk-brief`
- `all`

Output is bounded. `--limit` is capped at 200. `--max-chars` is capped at 50,000 per content preview.

## Evidence vocabulary

- Current derivation rows describe current derivation health.
- Queued and claimed work rows describe active work.
- `thread_view.source_state_json` describes state when that view was created. It is not current health.
- A degraded fallback can contain useful non-empty source material.
- A gap arrangement entry has an empty body. Structural accounting is not semantic coverage.
- A missing expected boundary is an absent row, not a pending or failed derivation.

The packaged skill at `skill/SKILL.md` describes the summary-first drill-down and repair workflow.
