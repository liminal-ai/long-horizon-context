# Chunk 2 ruling — hook 4 relocates; sampler injected at tee/open

**Chunk 2 of 3, Phase 3 of 3 — unit ~17 of 18.**

Your escalation was correct and well-made. I verified all four claims against
the tree myself before ruling; **all four are true**, and one of them means my
own brief specified a hook that cannot be built:

| Claim | Verified |
|---|---|
| Cargo cycle | **True.** `grok-lhc-host/Cargo.toml:21` already depends on `xai-chat-state`. A `grok_lhc_host::` call inside `request_builder.rs` is a cycle. |
| Sync vs async | **True.** `build_conversation_request` is a sync `pub(super) fn`, called from a sync match arm in `actor/mod.rs`; `get_llm_request_context` is async. |
| No session id on the actor | **True.** `ChatStateActor` (`actor/mod.rs:30-43`) carries no ACP session id. |
| Inference transport is shell-local | **True.** `ShellCompactionSampler` uses `crate::sampling::Client`; `grok-lhc-host` cannot depend on `xai-grok-shell` (that is the reverse cycle). |

So hook 4 as I specified it is impossible, not merely awkward. My brief
inherited "the canonical `xai-chat-state` request-builder boundary" from the
Phase 3 seam map without checking dependency direction or the sync/async
shape. That premise was factually wrong.

---

## Q1 = C, with a specific location — **relocate hook 4 to the shell**

Not the free-form "relocate" you proposed; a precise seam I verified:

- `ChatStateHandle::build_request` (`xai-chat-state/src/handle.rs:334`) is
  **`pub async fn`**.
- It has exactly **one** production call site in the shell:
  **`xai-grok-shell/src/session/acp_session_impl/turn.rs:2094`**.

At that site all three blockers vanish at once: it is **async-native** (await
`get_llm_request_context` directly — no cache, no staleness window, no
`block_on`, no C1-class bug), the **session id is in scope**, and the **shell
already depends on `grok-lhc-host`** so the dependency flows the correct way.

It is also strictly better for the fork than Option A. A trait plus
registration surface inside `xai-chat-state` would add permanent core surface
in a second crate; relocating keeps the fork's **entire** core footprint inside
`xai-grok-shell` plus the root `Cargo.toml` — the same crate as hooks 1, 2, 3
and 5. Less surface means fewer conflicts on every future upstream sync, which
is what FORK.md exists to protect.

**Hook budget is unchanged: still exactly two new hooks, total 5.** Hook 4 is
now `turn.rs`, not `request_builder.rs`. `xai-chat-state` gets **no** new
surface — do not add a trait, callback, or registration point to it.

### The thing this relocation puts on you

Substituting *after* `build_request` returns means the host has already
computed, against the **native** conversation: token accounting, the image
byte-budget eviction pass, memory-reminder injection, and integrity repair.
Swapping the items afterwards must not silently invalidate them.

Handle it explicitly and document the decision: either recompute what depends
on the body, or establish and test that each is unaffected. **A substituted
request whose token accounting describes a different conversation is a
correctness bug**, and it is the kind that shows up as mysterious truncation
much later. I want this named in your report, with a test per item.

Everything else from the brief stands: preserve `prompt_index`, system prompt
and tool definitions stay host-owned, no dangling tool calls, all-LHC or
all-native per request (never hybrid), fail open to the native path.

## Q2 = A — inject the sampler at tee/open

Supply an `Arc<dyn LhcInferenceSampler>` (your naming) from the shell at the
hook-2 site, into `tee_chat_persistence` / `spawn_capture`. The dependency
flows shell → host, which is the correct direction, and it needs **no new
marker** — hook 2's argument list widens, as it did in Chunk 1 for
`previous_model_id`.

- The trait is defined in `grok-lhc-host`; the real implementation lives in
  the shell alongside `ShellCompactionSampler` and reuses that transport.
- Adapter tests use a deterministic mock, per the brief.
- Report hook 2's post-`cargo fmt` `--numstat` again — it grows, and FORK.md's
  carve-out must be updated to the honest new number.

## What I am NOT ruling

If, in implementing this, you find that `turn.rs:2094` is not the only path by
which a request reaches the model — a second builder, a resume path, a
subagent path — **stop and report it**. A serving hook that covers some
requests and not others is worse than none, because the resulting corruption
would be intermittent.

## Process

C2 stands and you applied it correctly here: you stopped instead of inventing
a fourth touchpoint or reaching for `block_on`. That was the right call and it
saved a round. Keep doing exactly this.

Now produce the Chunk 2 implementation against this ruling. Same reporting
requirements as the brief.
