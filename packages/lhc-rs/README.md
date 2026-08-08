# lhc-rs

Rust port of the LHC (long-horizon context) SDK — `packages/lhc` is the
TypeScript reference implementation and stays the source of truth.

**Status: Phase 2 of 3 is ACCEPTED and dual-certified (units 9–15 of ~18
across the full project).** The host-agnostic Cargo library meets the final
Phase 2 gate:

```text
classified=511 cargo-reported=511 (binaries: 60)
passed=496 notimpl=0 ignored=15
wrong=0 suspicious=0
```

All seven implementation waves and the independent whole-phase Sol/Fable
completion audits are accepted. Phase 3 (Grok Build integration) remains the
larger user-facing deliverable—only Phase 3 puts LHC inside Grok Build.

This crate stays an in-process, host-agnostic Cargo library/SDK: no
Grok/Codex dependency, no C ABI, no network implementation; hosts supply
inference only through the canonical `ModelCall` seam.

### Phase 2 notes

The governing handoff is
[`docs/lhc-rs-port/phase2-brief.md`](../../docs/lhc-rs-port/phase2-brief.md).

- Behavior bodies are implemented against the ported suites; do not widen
  public surfaces without a TS counterpart.
- Keep `js_json` as the only serializer for persisted/hashed bytes; preserve
  closed vocabularies, SQL/label/diagnostic byte-exactness, and seam hooks.
- Profile `lowerBound` / band percentages are Amendment I `f64` (not `i64`);
  visibility budgets remain `f64` per Wave 6 rulings.
- Gate: `python3 scripts/check_gate.py` — final mode (zero real Phase-2
  todos) requires exact `496/0/15/0/0` (passed/notimpl/ignored/wrong/
  suspicious) with the transitional name allowlist retired
  (`scripts/gate_allowlist.txt` deleted). The gate hardcodes the expected
  passed count; slices that add tests must update `scripts/check_gate.py`
  and this README in the same commit.

## Working on the port

```sh
cargo check --tests
python3 scripts/check_gate.py
```

Committed oracle fixtures (regenerate only deliberately):

- `fixtures/js-json-cases.jsonl` — node JSON.stringify conformance for
  `shared_tech/js_json.rs` (`node scripts/gen-js-json-fixtures.mjs`)
- `fixtures/prompt-renders.json` — byte-parity contract for the nine prompt
  templates (`cd ../lhc && pnpm exec tsx ../lhc-rs/scripts/render-prompts-oracle.mjs`)
- `fixtures/profile-number-cases.jsonl` — Amendment I fractional profile /
  selection oracle
- `fixtures/date-parse-cases.jsonl` /
  `fixtures/derivation-json-order-cases.jsonl`
