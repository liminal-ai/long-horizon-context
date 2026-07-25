# Chunk 1 fix round 5 — final: coverage gaps and cleanliness

**Chunk 1 of 3, Phase 3 of 3 — unit ~16 of 18.**

Both verifiers agree: **no live product defect remains.** C1 is properly
fixed and guarded, B1's five acceptance cases all hold and are genuinely
sensitive, B2–B6 survived the rework, every earlier invariant holds, and
fmt / tripwire / numstat all match the docs. The implementation is done.

What is left is coverage of paths that ship untested, plus warning hygiene.
This is the last round before I commit — keep it tight and change no
production behavior except where D3 explicitly authorizes it.

---

## D1 [blocking] Hook 3's production entry point has zero test coverage

`capture_model_or_thinking_change` — the function LHC-HOOK 3/3 actually
calls — is invoked by **no test at all**, sync or async. Every model/thinking
test calls `handle.model_change(...)` directly, one layer below it. Untested
as a result: the `any_capture_active()` fast gate, the `lookup_session`
lookup, `level_label(None) → "none"` normalization, and the no-op suppression
at that layer.

Most consequentially: **if the session id at hook 3 did not match the one used
at hook 2, every model change would be silently discarded and nothing in the
suite would fail.** Both verifiers checked the two sites and they do match
(`session_id.0.as_ref()` vs `session_info.id.0.as_ref()`, both the ACP id), so
this is correct-but-unverified rather than broken. That is precisely the
structural blindness that hid C1 for a full round.

Add coverage that drives `capture_model_or_thinking_change` itself — the
public entry, not the handle — including the session-id match, the disabled
fast path, and `None` effort normalization. `apply` is an `async fn`, so at
least one of these must run under `#[tokio::test]`.

## D2 [blocking] The crash test still cannot detect a regression — third round

The implementation genuinely kills: `crash_kill` → the `Block` arm returns
true → `session.take(); break` with no drain and no `close()`, and the
`entered` rendezvous guarantees the worker is inside `Block` before items are
queued. That part is right.

But `crash_mid_batch_no_duplication_on_rerun` respawns with
`bootstrap = &items` and asserts 6 events — and if the kill regressed to a
calm drain, those same 4 queued items produce **exactly the same 6 events
under exactly the same keys**, and the bootstrap dedups. The assertion passes
either way. `wait_registry_gone` is non-discriminating too, since `crash_kill`
unregisters unconditionally before the worker reacts.

Fix (Opus's suggestion, and it is the right one): after the kill, reopen with
an **empty** bootstrap and assert **0 events** — proving the queued work never
committed — then do the repopulating respawn and assert 6. That single extra
observation makes the test discriminating.

## D3 [authorized production change] A refused open leaves a live, wasteful tee

**This one is a real behavior fix and I am explicitly requesting it — C2 does
not apply.** Opus reported it rather than fixing it, which was the correct call.

After `LhcSession::open` refuses, the worker returns and the channel closes,
but the tee still holds the `CaptureHandle`. Every subsequent `persist_message`
then performs a full `ConversationItem::clone()`, a failed `try_send`, and a
`note_drop("persist_closed")` `warn!` — for the rest of the session. On a long
session with `GROK_LHC=1` and a clobbered registry (exactly the B2/B5 refusal
scenarios), that is one item clone and one warn line per conversation item,
indefinitely.

Fix as the round-4 brief anticipated: have the tee consult shared state and
**stop teeing** once the channel is closed — skip the clone, and log the
transition once rather than per item. Keep it small and non-blocking. Test
that a post-refusal `persist_message` still reaches the inner persistence
(host behavior unchanged), performs no clone-and-warn per item, and that the
host session is otherwise unaffected.

## D4 [major] The crate is not warning-clean, and the mandated command hid it

`cargo check -p xai-grok-shell` — the **default-feature build that actually
ships** — emits two warnings from `grok-lhc-host` itself:
`unused variable: crash_rx` (`capture.rs:586`) and
`field crash_tx is never read` (`capture.rs:63`). Both are test-only machinery
living unconditionally in a production struct; `--features test-util` hides
them, which is why the clippy command I mandated reported clean. Separately,
`cargo clippy --features test-util` emits `items_after_test_module` at
`session.rs:410`.

The settled ruling excuses only warnings originating **inside the vendored
`lhc` crate**. These three are the fork's own. Gate the crash machinery behind
`#[cfg(any(test, feature = "test-util"))]` so it does not exist in the shipping
build, and move `paths_disagree` above the `#[cfg(test)] mod tests` block.
Both default and `test-util` builds must be warning-free for this crate.

## D5 [minor] Coverage and cleanup

- **The tee's own `ChatPersistence` methods are verified one layer below the
  shipping call.** `LhcTeePersistence::replace_history` and
  `persist_working_directory_switch_and_ack` are invoked by no test; all five
  B1 cases call `handle.replace_history` directly. Drive all four tee methods
  through the tee itself, at least one under an async context. They are
  non-blocking by inspection, so this is coverage, not a defect — but it is
  the same shape as the gap that hid C1.
- **Unused direct dependencies:** `futures` and `serde` are declared in
  `crates/lhc/grok-lhc-host/Cargo.toml` and referenced nowhere. Since
  `xai-grok-shell` now depends on this crate, they enter the shell's graph for
  nothing. Remove them.
- **Test-strength nits:** `replace_history_records_compaction_meta_only` never
  asserts the new event's kind or summary content, and
  `replace_history_records_repair_tool_result_only` never asserts the tool call
  id or content — each would pass if an unrelated single event were substituted.
  Assert kind and payload in both.
- **C1 guard runtime shape:** the two async guards use
  `flavor = "multi_thread"`, while the sole production caller runs
  `spawn_session_actor` on a **current-thread** runtime with a `LocalSet`
  (`spawn.rs:2194`). Add or convert one guard to the current-thread flavor so
  the guard matches the shipping shape. Also note both guards catch only
  *panicking* blocks — a non-panicking `join()`/`recv()` would hang rather than
  fail; add a timeout so the guard fails fast instead of hanging CI.

---

## Report

Position against the full project. For **D1–D5**: fixed / not fixed and why.
Give final counts (unit / certification / golden), and confirm **both**
`cargo check -p xai-grok-shell` (default features) and
`cargo clippy --features test-util` are warning-free for `grok-lhc-host`.
Confirm no production behavior changed except D3.
