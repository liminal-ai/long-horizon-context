# lhc-rs

Rust port of the LHC (long-horizon context) SDK — `packages/lhc` is the
TypeScript reference implementation and stays the source of truth.

**Status: Phase 1 in progress (API surface + tests, no behavior).** Every
ported function body is `todo!("phase 2")`; nothing works yet. Phase 2
(implementation to green against the ported test suite) is a separately
scoped effort — see `docs/lhc-rs-port-phase1-brief.md` at the repo root for
the plan and `PORT_STATUS.md` here for the live ledger.

Consumers (planned): in-process host integrations vendoring this crate —
`liminal-ai/grok-build-lhc` first, a Codex fork second. The crate is
host-agnostic: no network calls; hosts supply inference via `ModelCall`.

## Working on the port

```sh
cargo check --tests        # must stay clean from Wave 0 on
python3 scripts/check_gate.py   # the Phase 1 verdict: WRONG=0 or it fails
```

Committed oracle fixtures (regenerate only deliberately):

- `fixtures/js-json-cases.jsonl` — node JSON.stringify conformance for
  `shared_tech/js_json.rs` (`node scripts/gen-js-json-fixtures.mjs`)
- `fixtures/prompt-renders.json` — byte-parity contract for the nine prompt
  templates (`cd ../lhc && pnpm exec tsx ../lhc-rs/scripts/render-prompts-oracle.mjs`)
