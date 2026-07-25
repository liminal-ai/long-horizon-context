# Chunk 2 implementor brief — inference adapter and context/compaction injection

**Chunk 2 of 3, Phase 3 of 3 — unit ~17 of 18.** Chunk 1 (capture) is DONE,
dual-verified, committed and pushed (fork `af62816`). Chunk 3 (product wiring,
migration, live certification) remains after this and is what actually
delivers the user-facing result.

Chunk 1 gave LHC a faithful record of the session. **Chunk 2 makes that record
drive what the model sees.** That is a much higher-stakes seam than capture: a
capture bug loses history, a serving bug corrupts the live conversation.

## Repos and rules — unchanged from Chunk 1

- Work in `/srv/work/grok-build`, branch `lhc`. Leave work **uncommitted**;
  I am the sole committer.
- Read `/srv/work/grok-build/FORK.md` **first**, in full — including the new
  "Accepted limitations" section. Every rule binds.
- `crates/lhc/vendor/long-horizon-context` is **read-only**. Never edit it.
  If you think the port must change, STOP and report.
- Adapter code goes in `crates/lhc/grok-lhc-host/`.
- Exhaustive matches over host enums; **no wildcard `_ =>` arms**.
- **`GROK_LHC` off ⇒ host behavior bit-identical.** Chunk 1 holds this; do not
  regress it.
- **C2 still applies: report out-of-scope findings, do not fix them.** In
  Chunk 1 an unrequested "improvement" put a blocking call on the async path
  and panicked every session spawn. That rule exists because of it.

## Seams — verified at the current tip 2026-07-25, re-check before editing

| Seam | Location | Note |
|---|---|---|
| Request construction | `xai-chat-state/src/actor/request_builder.rs:37` `build_conversation_request` | the canonical boundary; command at `commands.rs:208` |
| Auto-compaction gate | `xai-grok-shell/src/session/compaction.rs:1789` `should_auto_compact` | existing trigger |
| Compaction sampler | `xai-grok-compaction/src/sampler.rs:120` `CompactionSampler::sample_compaction` | the template for ModelCall — host already runs compaction on a dedicated non-main model |
| Turn/rewind identity | `xai-chat-state/src/types.rs:36,52` `prompt_index`, `last_compaction_prompt_index` | **hard constraint below** |

**Hard constraint (from the Phase 3 brief):** any substituted conversation view
**must preserve `prompt_index`**, or rewind and fork break. Treat this as a
correctness invariant with its own tests, not a detail.

## Enumerated core touchpoints — exactly two new hooks, total becomes 5

| # | File | Purpose |
|---|------|---------|
| 4 | `xai-chat-state/src/actor/request_builder.rs` | obtain LHC's request context and substitute it |
| 5 | `xai-grok-shell/src/session/compaction.rs` | compact bridge at the existing auto-compact gate |

Anything beyond these two is an escalation: **stop and report**. In the same
change: bump `EXPECTED_HOOKS` to 5 in `scripts/check-lhc-hooks.sh`, extend
FORK.md's touchpoint inventory, and note that `patches/` needs regeneration
(I regenerate and re-rehearse after committing — see `patches/README.md`).

Hook-size rule as amended in Chunk 1: keep each marked insertion as small as
possible and **leave the host expression textually intact** where you can
(hook 2's `let`-hoist is the pattern). Report honest post-`cargo fmt`
`--numstat` for both files; a carve-out with real numbers is fine, a number
achieved by non-canonical formatting is not.

## 1. ModelCall — real inference, replacing the Chunk 1 stub

`crates/lhc/grok-lhc-host/src/inference.rs` currently returns a classified
refusal for all four operations. Replace it with a real implementation over
Grok's in-process sampling abstraction. The audit found **zero core patch
needed here** — `CompactionSampler` shows the shape the host already supports.

You must implement all four `InferenceCallbacks`
(`vendor/.../shared_tech/derivation.rs:300`): `smooth_prompt`,
`summarize_tool_result`, `compress_detailed_turn`, `summarize_chunk_brief`,
each `Fn(Input) -> BoxFuture<InferenceResult>`.

Requirements:
- **Run on a dedicated non-main model**, like native compaction does — do not
  consume the user's main-model budget.
- Preserve **cancellation**, model identity, token limits, timeout, and
  request/response provenance (`InferenceResult::Ok` carries `provenance` and
  `request_messages` — populate them; they are how Chunk 3 proves LHC
  constructed the request).
- **Classify failures** rather than collapsing them: map host sampling errors
  onto `InferenceResult::Err { reason, .. }` with a reason that distinguishes
  timeout / cancellation / transport / refusal.
- **No nested host deadlock.** The capture worker owns its own runtime; do not
  block a host runtime thread waiting on inference, and do not call back into
  the chat-state actor from inside an inference callback. Chunk 1's async
  guards exist for this class — extend them to cover the inference path.

## 2. Request-context serving — hook 4

At `build_conversation_request`, when LHC is enabled and healthy, obtain
`lhc.thread_view.get_llm_request_context(thread_ref)` and translate it into
the host's `ConversationItem`s.

**Translation constraint you must design around:** LHC's serving view is
deliberately narrow — `LlmRequestContextMessage { role: User | Assistant,
content: Vec<LlmRequestContextPart { type_, text }> }`
(`vendor/.../shared_tech/view.rs:173-200`). There is **no system role and no
tool-call representation**. Consequences to handle explicitly and document:
- The **system prompt and tool definitions stay host-owned** — LHC's view
  replaces the conversation body, not the system preamble. Do not let a
  substitution drop or reorder them.
- Because the view carries no tool calls, a substituted body **cannot contain
  a dangling tool call** — but you must confirm the host does not separately
  expect a tool result whose call you just removed. Test the case where
  substitution happens mid-tool-cycle.
- **`prompt_index` must survive.** Decide how indices map onto a substituted
  body and prove it with rewind and fork tests.

Do not alter system/tool semantics, message ordering, or token accounting
contracts.

## 3. Compact bridge — hook 5

Integrate LHC's `compact` / `preview_compact` / `prune`
(`vendor/.../sdk.rs` — `thread_view` surface) at the existing auto-compaction
trigger (`should_auto_compact`).

**Ruling — implement both modes, never two writers.** The Phase 3 brief says
to decide explicitly whether LHC *replaces* or *shadows* `xai-grok-compaction`
and forbids two writers on one request. My decision:

- **`shadow` (default when `GROK_LHC=1`):** native compaction still drives the
  conversation; LHC computes what it *would* do via `preview_compact` and
  records it. This is what produces the "comparison against existing
  compaction on representative long sessions" the certification requires.
- **`replace` (explicit opt-in, e.g. `GROK_LHC_COMPACT=replace`):** LHC's
  compaction drives; native auto-compact is suppressed for that session.
- These are **mutually exclusive by construction**, not by convention. Make it
  impossible to have both write to one request — a shared enum consulted once
  per decision point, not two independent booleans. Test that.

Chunk 3 flips the default after live certification; do not flip it here.

## 4. Failure policy — ruled, do not re-litigate

**Fail open to the existing path.** If LHC errors, is unavailable, or returns
an unusable view, the host must fall back to its own conversation and native
compaction, log loudly and once, and continue serving the user. Cited: the
Phase 3 brief requires "an immediate feature-flag/config rollback to the
existing compaction path until live certification is complete" — a
fail-closed serving path would contradict that guarantee.

Corollary, and test it: **a fail-open fallback must never produce a hybrid
request** — partially-LHC, partially-native. It is all-LHC or all-native per
request, decided once.

## Certification you must deliver

- Adapter contract tests with a **deterministic mock sampler** (no live model
  in the suite).
- **Byte/structure goldens**: captured history → LHC context → sampling
  request. Hand-authored expectations, in the Chunk 1 goldens style — and note
  Chunk 1's lesson: goldens generated by the code under test certify nothing.
- Threshold / abort / failure / fallback / concurrent-request tests.
- Comparison of LHC vs existing compaction on representative long sessions
  (this is what `shadow` mode is for).
- **No context injection when disabled**, and none when LHC fails under the
  fail-open policy above.
- `prompt_index` preservation across substitution, rewind, and fork.
- Chunk 1's 61 tests stay green; the tripwire stays green with sentinel 5/5.
- Both `cargo check -p xai-grok-shell` (default features — the shipping build)
  and `cargo clippy --all-targets --features test-util` **warning-free for
  this crate**, and `cargo fmt --check` clean in both crates. Run these exact
  commands; Chunk 1 had three rounds where "clean" did not survive them.

## Carried from Chunk 1

FORK.md "Accepted limitations" item 2: the async-convention guards catch
panicking blocks but hang rather than fail fast on silent ones, because the
awaited body has no suspension point. Close it with an out-of-runtime watchdog
(a separate thread that fails the test after N seconds), and extend the guards
to the new inference and serving paths.

## Reporting

State your position against the full project ("Chunk 2 of 3, Phase 3 of 3 —
unit ~17 of 18"), and what remains. Report: every file changed; the two hooks'
post-fmt `--numstat`; every design decision you had to make and why; the
`prompt_index` mapping; anything you could not do; and anything that pushed
you toward the vendored port or a third core touchpoint.

## Escalate — stop and report, do not work around

- A seam above has moved or vanished at the current tip.
- A needed core touchpoint beyond hooks 4 and 5.
- Any need to change the vendored `lhc` crate's behavior or public shape.
- Genuine ambiguity where two defensible designs would behave differently and
  neither the host source nor this brief decides it.
