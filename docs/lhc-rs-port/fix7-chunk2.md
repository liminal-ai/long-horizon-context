# Chunk 2 fix round 7 — the gate re-run failed; suite is red

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

**The hard gate re-run FAILED.** Both verifiers returned CHANGES REQUIRED. The
fixpoint property itself **holds** — that repair worked, and both verifiers
confirmed it from source. What failed is everything around it.

**Read this first: the adapter test suite is RED and has been for two rounds.**
`cargo test --features test-util -p grok-lhc-host` → `44 passed; 1 failed`.
You reported green each round, and so did I, because
`scripts/check-lhc-hooks.sh` ran only the two **integration** binaries
(`--test golden_smoke`, `--test certification`) and never `--lib`. Every
write-back unit test added in the H-round lives in `src/serving.rs` and was
structurally invisible to the gate.

**I have already fixed the tripwire** — it now runs `--lib` first and currently
reports `TRIPWIRES FAILED`. Do not revert that. From now on the gate sees your
unit tests. Run the **full** `cargo test`, not the script alone, before
reporting.

---

## L1 [blocking] The failing test asserts something arithmetically impossible

```
serving::tests::serving_skips_bands_for_prompt_index
  serving.rs:589   left: [0, 1]   right: [0, 1, 2]
```

`realistic_post_compact_ctx()` contains exactly **two** real-user messages; the
bands, tool result, runtime note and model change are all synthetic. So
`assign_prompt_indices` can stamp at most two markers, and the test demands
three. As written it can never pass.

Both verifiers also note the deeper point: **serving uses head assignment
(`[0, 1]`) while write-back uses tail assignment (`[1, 2]`)**, and neither
matches what a reviewer would expect from "the two surviving live markers."
Decide which is correct for **serving** specifically — with the reason written
down, since write-back's tail rule is already justified and documented and
serving's is not — then make the test assert the real property rather than a
literal you chose to make it pass. This is the test named to guard
`prompt_index` assignment; it must be able to fail.

## L2 [blocking] Prefix-only classification lets a real user prompt be dropped

Sol constructed this and I confirmed it against source. `is_lhc_synthetic_user_text`
(`serving.rs:15-19`) classifies **by text prefix alone**. So:

1. A collapsed band item with bytes `F` records at digest occurrence 0.
2. Later the bands change, so the new band item has different bytes.
3. A real user pastes exactly `F` (it starts with `[context · `).
4. `context_to_writeback_items` sees `saw_non_band == true`, and the prefix
   test classifies the prompt as synthetic → `ConversationItem::user_meta(F)`.
5. That item is byte-identical to the earlier band item at an aligned
   occurrence, so **dedup drops a genuine user turn.** It is also excluded from
   `prompt_index` assignment.

**Adjudication — this is your bug, not the dedup contract.** Lee ruled
identical-content dedup correct by design and that ruling stands: as Sol notes,
an item that stayed `synthetic_reason: None` would **not** collide, because the
digest includes the enum representation. The collision exists only because the
classifier wrongly converts a real prompt into meta. Fix the classifier and the
counterexample evaporates.

Constraint that makes this non-trivial: `LlmRequestContext` carries only role
and text (`vendor/.../view.rs:197-207`) — the band provenance in
`AssembledContextMessage.band` is **dropped** at the SDK boundary, and the
vendored port is read-only, so you cannot recover it from the context alone.

The information you *do* have is the **native conversation**, which
`build_writeback_conversation` already receives. A text that matches a known
native real-user prompt is a real user regardless of its prefix. Use that, or
propose something better — but state the residual ambiguity you are left with
and which direction you chose to fail in. **Fail toward preserving real user
content**: wrongly keeping a synthetic item as a real user costs a spurious
`prompt_index` slot; wrongly dropping a real prompt loses the user's words.

**If you conclude no sound classification is reachable inside the adapter,
stop and report** — that becomes an escalation about the SDK boundary, not
something to approximate.

## L3 [blocking] Off-by-default is violated — per-turn mutex when LHC is off

`turn.rs:2124` calls `capture_active()` every turn, which is
`is_session_registered` → `lookup_session` → **registry mutex + `Weak`
upgrade** (`capture.rs:400`), even when `GROK_LHC` was never set.

"No added per-turn work when off" is a standing law, and E2 was supposed to
have established this pattern. The cheap gate already exists:
**`any_capture_active()` (`capture.rs:404`) is a single relaxed atomic load.**
Gate on that first, everywhere a per-turn path consults capture state, then
fall through to the registry lookup only when it is true. Audit every hook for
the same mistake, not just this one.

Add a test that fails if a disabled-path turn touches the registry.

## L4 [blocking] The equivalence instrument will report permanent false divergence

Write-back collapses N bands into **one** `user_meta` item; serving emits **N**
separate band items. `compare_serve_equivalence` compares projected item counts
(`equivalence.rs:238-254`), and correctly does not normalize count away. So
after any write-back, observation reports **informational divergence
deterministically**, with identical band text and identical information.

That poisons the evidence the hook-4 removal ruling depends on: the actionable
signal fires on a representation difference that carries no information
difference. Fix so the comparison is meaningful across the collapse — the
honest options are to canonicalize the band representation on both sides before
projecting, or to compare band content as a unit rather than per item. **Do not
fix it by normalizing away item count generally** — that would blind the
instrument to real structural loss, which is the thing it exists to catch.

Test it on a realistic post-write-back body, which the current tests do not
cover.

## L5 [major] The projection normalizes message content

Collapsing all Unicode whitespace can hide indentation, line-break, and
whitespace-sensitive differences in code or JSON payloads. The brief said the
projection must **not** normalize away message content. Tighten it, and
document precisely what remains normalized and why.

## L6 [major] Tests that cannot fail

- **H3's rewind test writes the checkpoint manually**, so it would still pass
  if the production `persist_compaction_checkpoint` pairing were deleted. Bind
  it to the production path.
- **The crash test's crash point is not mid-write-back** — it blocks the worker
  and kills before the replace begins, so it would not catch a true mid-apply
  bug. Both verifiers flagged this across two rounds now. Either exercise a
  crash after partial application, or state precisely why the adapter cannot
  and register it for the Chunk 3 harness, which drives the real path.
- **H6's test never commits an LHC compact**, so it demonstrates bootstrap
  dedup rather than the actual crash window.

## L7 [minor] Fixture causal faithfulness, and doc drift

- `writeback_fixture`'s native history contains a plain assistant followed by
  tool result `c1`, not an assistant tool call named `bash` — so that native
  history could not itself render the `[tool call · bash]` / `[tool result ·
  bash]` context it is paired with. Make the fixture causally coherent.
- `MAPPING.md` still names the removed `accounting_token_totals_unaffected_by_substitute`
  test.
- FORK.md records hook 4 as `+45/-0`; actual is `+46/-0`. Re-verify every
  numstat.

---

## Report

Position against the full project. For **L1–L7**: fixed / not fixed and why.
Lead with L2 — the classification rule you chose, what information it uses,
the residual ambiguity, and which direction you chose to fail in. Then confirm
the **full** `cargo test` passes (not just the script), state the counts for
lib / certification / goldens separately, and confirm `--all-targets` clippy is
clean with warnings attributed to files. Confirm you did not touch the capture
tee, the dedup behaviour, or the vendored port.
