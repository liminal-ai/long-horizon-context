# lhc-rs

Rust port of the LHC (long-horizon context) SDK — `packages/lhc` is the
TypeScript reference implementation and stays the source of truth.

**Status: Phase 2 Wave 7 of 7 is dual-certified (unit 15 of ~18 across the
full project); whole Phase 2 acceptance is pending the independent completion
audit.** The host-agnostic Cargo library reaches the Phase 2 gate target

```text
classified=496 cargo-reported=496
passed=481 notimpl=0 ignored=15
wrong=0 suspicious=0
```

Wave 7 is committed only after its certification record is finalized; the
separate Phase 2 audit must still accept the complete seven-wave range.
Phase 3 (Grok Build integration) then remains and is the user-facing
deliverable—only Phase 3 puts LHC inside Grok Build.

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
  todos) requires exact `481/0/15/0/0` with the transitional name allowlist
  retired (`scripts/gate_allowlist.txt` deleted).

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
