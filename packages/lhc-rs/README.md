# lhc-rs

Rust port of the LHC (long-horizon context) SDK — `packages/lhc` is the
TypeScript reference implementation and stays the source of truth.

**Status: Phase 1 dual-certified (unit 8 of ~18 across the full project; API
surface + tests compiled; nothing runs yet).** Every behavior body is still
`todo!("phase 2")`. The Phase 1 gate reports exact-todo **513** and **493**
classified tests (**40** allowlisted REAL passes, **438** notimpl, **15**
ignored) with wrong/suspicious **0**, across **72** source / **53** test /
**18** fixture ledger rows (only the two live-network artifacts remain
EXCLUDED: `inference-real` suite and `openrouter-call` fixture). See
`PORT_STATUS.md` for the certification record.

Phase 2 (implement behavior to green against this suite) is the larger
remaining effort. Phase 3 (Grok Build integration) is still ahead — only
Phase 3 delivers LHC inside Grok Build. This crate stays an in-process,
host-agnostic Cargo library/SDK: no Grok/Codex dependency, no C ABI, no
network implementation; hosts supply inference only through the canonical
`ModelCall` seam.

### Phase 2 handoff

The governing handoff is
[`docs/lhc-rs-port/phase2-brief.md`](../../docs/lhc-rs-port/phase2-brief.md).

- Flip each `todo!("phase 2")` to real behavior against the ported suites;
  do not widen public surfaces without a TS counterpart.
- Keep `js_json` as the only serializer for persisted/hashed bytes; preserve
  closed vocabularies, SQL/label/diagnostic byte-exactness, and seam hooks.
- Audit live cancellation for `CompactAbortSignal` before certifying compact
  behavior; retain `lowerBound`/`profile` percentages as `i64` and visibility
  budgets as `f64` per Wave 6 rulings.
- Gate: `python3 scripts/check_gate.py` must stay wrong=0; shrink notimpl as
  suites turn green and retire Phase 1 allowlist entries that become ordinary
  behavior passes.

## Working on the port

```sh
cargo check --tests        # must stay clean
python3 scripts/check_gate.py   # Phase 1 verdict: WRONG=0 or it fails
```

Committed oracle fixtures (regenerate only deliberately):

- `fixtures/js-json-cases.jsonl` — node JSON.stringify conformance for
  `shared_tech/js_json.rs` (`node scripts/gen-js-json-fixtures.mjs`)
- `fixtures/prompt-renders.json` — byte-parity contract for the nine prompt
  templates (`cd ../lhc && pnpm exec tsx ../lhc-rs/scripts/render-prompts-oracle.mjs`)
