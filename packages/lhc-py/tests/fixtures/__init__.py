"""Ported from packages/lhc/test/fixtures/index.ts (+ sibling helpers). Phase 1.

Not yet ported — helpers land at the start of the first wave whose tests need
them (Wave 1 for the inference double, Wave 3 for tempStore/threads/intake).
Data files (pi-session-structure.jsonl, .provenance.md) are copied verbatim.
Pure data-construction helpers (event literals like validEvent) are ported as
REAL values; helpers that call the SDK are skeletons.
"""
