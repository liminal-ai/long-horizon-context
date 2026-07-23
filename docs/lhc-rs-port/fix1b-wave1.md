Narrow correction before re-verification. Work only under `packages/lhc-rs/`;
do not commit or push. This resume must use `cursor-grok-4.5-high-fast`, and
any internal Cursor task must use the same fast model.

The fix round widened `src/intake_stream/mod.rs::message_events` from the
faithful TS/Rust `ThreadRef` API to `serde_json::Value` solely to express the
unknown-envelope negative test. That violates the Phase 1 public-surface
contract and the top-level fix instruction not to weaken the valid closed
`ThreadRef`.

Fix it:

1. Restore `message_events(_thread_ref: ThreadRef, ...)` exactly as TS
   `messageEvents(threadRef: ThreadRef, ...)`; update normal call sites back to
   typed `ThreadRef`.
2. Ensure `ThreadRef` serde uses `deny_unknown_fields` (or an equivalent closed
   wire representation) so deserializing
   `{"filePath": "...", "surprise": true}` fails specifically because of the
   unknown field.
3. In the strict-envelope test, exercise that wire/serde boundary and assert
   the failure names `surprise`/unknown field. Preserve the event-level and
   payload-level legs through `message_events`.
4. Record this Rust representation judgment in `PORT_STATUS.md`: TS's
   cast-through-invalid-object call is represented by rejection at the serde
   boundary; the valid public API remains closed `ThreadRef`. Do not invent a
   second public wire API.
5. Run `cargo fmt --check`, `cargo check --tests`,
   `python3 scripts/check_gate.py`, and `python3 scripts/check_prompt_bytes.py`.
   Gate must retain wrong=0/suspicious=0.

Also remove only the generated untracked
`packages/lhc-rs/scripts/__pycache__/` directory before reporting.
