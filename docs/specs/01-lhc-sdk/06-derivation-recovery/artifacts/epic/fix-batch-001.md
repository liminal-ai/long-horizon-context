# Epic 06 Fix Batch 001 — canonical epic-review blockers

Source: `artifacts/epic/001-epic-review.json`.

Constraints for the whole batch:
- No schema changes.
- No new dependencies.
- Keep compact no-provider behavior intact.
- Keep Story 5 runtime-change typed blocks intact.
- Fix only the blocking findings below; carry non-blocking rename vocabulary cleanup and real-inference skip as recorded observations.
- Re-run `cd packages/lhc && pnpm run verify` and `cd packages/lhc && pnpm run verify-all`.

- [ ] **E06-BLOCK-001: Turn-close recovery bypasses the tool-result large-tier gate.** The queued message handler applies the large-tier truncation rule and avoids provider calls for over-large tool results, but turn-close recovery in `packages/lhc/src/domains/turns/internal/derive.ts` independently calls `run.provider.summarizeToolResult` for `tool_result_summary` recovery with raw content and no tier gate. Fix recovery so over-large tool results use deterministic truncation with no provider call, consistent with `packages/lhc/src/domains/messages/internal/handlers.ts` and `packages/lhc/src/domains/messages/index.ts`. Add focused coverage for a failed or pending over-large `tool_result_summary` consumed during turn-close recovery, asserting deterministic truncation and zero provider calls for that recovery leg.

- [ ] **E06-BLOCK-002: Absent derivation fallback is not logged.** `packages/lhc/src/domains/turns/internal/compose.ts` records a dependency gap for missing derivation rows but only creates a recovery receipt when a derivation row exists. `packages/lhc/src/domains/turns/internal/derive.ts` logs only recovery receipts, so absent `smoothed_prompt` or `tool_result_summary` rows can fall back without a log entry. Fix composition/recovery receipt construction so absent derivation-row fallbacks produce loggable recovery receipts, then add coverage proving an absent row fallback writes the required fallback log entry.

Non-blocking findings carried forward:
- `E06-NB-001`: form-to-derivation vocabulary cleanup remains incomplete in internal production names.
- `E06-NB-002`: real-inference tests are skipped when `LHC_OPENROUTER_KEY` is unset.
