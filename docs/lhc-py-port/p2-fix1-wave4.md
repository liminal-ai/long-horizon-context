You are the IMPLEMENTOR for PHASE 2 Wave 4 fix round 1. Sol's audit: FAIL, 5 blockers + 1 minor. Contract: docs/lhc-py-port/phase2-brief.md. Branch lhc-py-port, no commits, nothing outside packages/lhc-py/, TESTS IMMUTABLE. Fix ALL, re-run gate, report per finding.

FINDINGS:
1. [blocker] messages/__init__.py:494,570 — edit/remove signatures were widened to accept dicts with camelCase/snake fallbacks. Phase 1 froze `EditInput`/`RemoveInput` dataclass params; TS accepts exactly {messageId, content}/{messageId}. Restore the frozen signatures; delete the dict-fallback lines (~502–505, ~578–580). If any test passes dicts there, STOP and report the test line (orchestrator handles tests).
2. [blocker] messages/internal/cascade.py:157 — `_RebuildGroup` reverted from frozen+slots to mutable. Restore `@dataclass(frozen=True, slots=True)`; do updates immutably (dataclasses.replace / rebuild), even though TS mutates its local — the certified Python representation stays frozen.
3. [blocker] messages/internal/store.py:181 — tool-call edit token counting: json.dumps needs ensure_ascii=False (TS estimateTokens(JSON.stringify(content)); "é" → 3 tokens not 6).
4. [blocker] messages/internal/store.py:172 — decoded non-object block must RAISE (→ rollback) like TS mutating a scalar's property; do not silently substitute {} and commit rewritten content.
5. [blocker] messages/internal/cascade.py:189 — replace set[WorkKind] with insertion-ordered structure (ordered list + membership set, or dict keys) so `superseded` ordering is deterministic and TS-faithful (TS reads derivations ORDER BY type into an insertion-ordered Set).
6. [minor] messages/__init__.py:235 — diagnostic value interpolation must use JS spelling: True→true, False→false, float('nan')→NaN, inf→Infinity, None→null (write a small _js_repr helper; check other value-bearing messages use it too).

GATE: cd packages/lhc-py && uv run python scripts/check_gate.py → wrong=0, no regression below 269, collection clean.

FINAL REPORT: per-finding status, X/455, gate verbatim, disputes with TS evidence.
