# Phase 4 / Chunk 2 — round 5: REAL inference for derivations

Resume the same session. **Do not commit, do not push.**
Position: **unit 21 of 22.**

Lee has ruled the auth lane, and it removes the reason the derivation path
was stubbed. His instruction is explicit: **real inference for derivations,
not shims.**

## The ruling (brief commit `8c3ca18`)

> Derivation calls ride **ChatGPT auth** — the same auth Lee runs Codex with
> — on **`gpt-5.6-luna`** at the **lowest reasoning effort** (`none` if the
> client accepts it, else the minimum available), **both derivation lanes**
> (small-op and big-op), through the **in-process ModelClient only** (no CLI
> spawns as providers). Plan-quota spend accepted; report per chunk.

Live band-shape eval is also **AUTHORIZED** (~5–10k tokens on plan quota).

---

## J1 — BLOCKING. Real inference is the production default; deterministic is
test-only

`compact_lhc.rs:94`:

```rust
let use_live = std::env::var("CODEX_LHC_LIVE_INFERENCE").ok().as_deref() == Some("1");
```

So production derivations run **deterministic canned text** unless an env var
is set. That is the shim Lee is rejecting. LHC's whole value is derived
bands; serving deterministic placeholder text as a compacted conversation is
worse than not compacting, because it looks like content.

**Ruling:**

- Real `ModelClient` inference is the **default** path for the LHC compact
  arm when the feature is enabled.
- Deterministic callbacks are **test-only**. They may be selected explicitly
  by tests; they must not be what a real session silently gets.
- If the real client is unavailable (no auth, no client, construction
  fails), **fail open to the native ladder** — `Unavailable { reason }` at
  `warn`. Do **not** substitute deterministic text. Law 3: degrade to
  Codex's own compaction, never to fake content.
- Delete `CODEX_LHC_LIVE_INFERENCE` as the production switch. If you want a
  test-only escape hatch, make it explicit and inverted
  (e.g. deterministic only under `cfg(test)` or an explicit test constructor).

**Test:** a session with the feature on and a working client uses the real
bridge (assert the bridge is invoked, not the deterministic callbacks); a
session with no usable client returns `Unavailable` and reaches the native
ladder — **not** deterministic text.

---

## J2 — BLOCKING. Pin the model and effort per the ruling

`lhc_inference_bridge.rs:55` uses `turn_context.model_info` — i.e. whatever
model the user's turn happens to be on — and `:111` passes `effort: None`
meaning "unspecified", not "effort none".

Neither matches the ruling. Derivation must not ride the user's turn model:
that would spend the user's premium model on bookkeeping and make derivation
cost vary with their model choice.

**Ruling:**

- Pin **`gpt-5.6-luna`** for all four derivation callbacks (`smooth_prompt`,
  `summarize_tool_result`, `compress_detailed_turn`,
  `summarize_chunk_brief`) — that is both lanes.
- Pass **`ReasoningEffort::None`** explicitly (the variant exists at
  `protocol/src/openai_models.rs:41`). If the client rejects it for this
  model, fall back to the minimum it accepts and **log which** — do not
  silently land on a higher effort.
- Resolve the model through the normal model-info path so provider routing
  and auth work as they do for any other in-process call. **No CLI spawns as
  providers.**
- If `gpt-5.6-luna` is unavailable for the configured provider, fail open
  (J1's rule), do not fall back to the turn model.

**Test:** assert the request carries the pinned model and the lowest effort,
for every one of the four callbacks. Must fail if either is changed.

---

## J3 — Run the live band-shape eval, and report real cost

The harness has been sitting behind `#[ignore]` since 2a waiting on this
ruling. It is now authorized.

- Run it for real, on the ruled lane (ChatGPT auth, `gpt-5.6-luna`, lowest
  effort).
- Keep it the smallest history and fewest turns that would reveal
  incoherence — this is a bounded spend, not a benchmark.
- **Report actual token usage and turn count.** Lee asked for per-chunk
  reporting; I need real numbers, not the estimate.
- Report the model's behaviour on band-shaped replacement history plainly:
  does it stay coherent, does it reference the bands sensibly, does it
  behave as if context is missing?

If the result is negative — the model does not tolerate band-shaped history
— **stop and report**. Do not design a mitigation in this round; that is a
ruling I owe Lee, not a fix you should improvise.

---

## Standing bar

- Tests round-trip the production path.
- Every invariant proven by mutation: break it, paste the failure, restore,
  re-pass. Paste real output.
- No test that cannot fail. No deterministic-text substitution anywhere a
  real session can reach.
- Do not commit, do not push.

## Out of scope

H1–H4 and I1–I2 are settled. Do not restructure them.
