Targeted re-verification of Wave 1 fix round 1. VERIFICATION ONLY: do not
leave edits, commit, or push. You previously returned FAIL; re-open the current
worktree and confirm every finding from your prior report against the current
TS source and binding brief. The other verifier's report remains unavailable
to you.

Re-run the full required gates and report output verbatim:

```
. "$HOME/.cargo/env"
cd packages/lhc-rs
cargo fmt --check
cargo check --tests
python3 scripts/check_gate.py
python3 scripts/check_prompt_bytes.py
```

Required targeted coverage:
- goldens are regular standalone byte-identical copies;
- registry carries actual callable dispatch and tests route through it;
- prompt checker exact full message/role/order/join reconstruction, all 164
  relevant constants/wiring, and adversarial mutation detection for each
  claimed producer/path;
- all six suite counts expanded correctly, especially inference-prompts 25/25;
- typed `valid_event` compile-fail contract and three malformed-config legs;
- `message_events` public signature remains faithful closed `ThreadRef`; the
  extra envelope is rejected at serde boundary without widening the API;
- exact invalid-envelope/event/payload, damaged-source, logging fail-soft,
  metadata, captured-input, and regex-order assertions;
- `smallTierTokens`, closed `MessageKind`, ordered persisted maps,
  transaction borrowing, serde omission, exhaustive vocab matches;
- no invented/premature later-wave shapes;
- every behavior body in changed source/fixture scope follows the Phase 1
  exact-todo rule, with only recorded pure fixture/sqlite adapter exceptions;
- gate parser changes for trybuild do not hide real Cargo tests or weaken
  reconciliation;
- ledger ticks, rulings, and the Wave 0 allowlist override are honest;
- no new regression introduced by the fixes.

Verdict format: `VERDICT: PASS` or `VERDICT: FAIL`; findings only with
file:line, severity, TS evidence, and exact correction; verbatim gate output;
honest fully-reviewed/skipped coverage note and mutation checks.
