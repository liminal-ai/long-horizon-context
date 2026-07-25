# Chunk 2 fix round 16 — make the coverage claim true

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Both verifiers independently confirm **the engineering in U1/U2 is sound**. One
ran a 63-contribution deletion sweep; U1's fourteen fields plus
`model_fingerprint` and the action variants are all genuinely deletion-caught.
`push_option_str`'s presence bit is load-bearing (forcing the `None` arm to emit
`"s"` fails five tests) and **cannot be spoofed** — a payload starting with
`s`/`n` lands in the second length-framed field and cannot migrate into the
first. FORK.md's carve-out table is verified correct and complete. The tree was
restored byte-identical.

**The code is right. The documented claim is not.** That is the whole of this
round.

---

## W1 [blocking] MAPPING.md asserts coverage that does not exist

MAPPING.md states a universal pin-coverage guarantee. A sweep deleting each of
**63** framed contributions one at a time found **41 survive** against the full
175-test suite — they can be removed and every test stays green.

Survivors are payload and identity fields, not the framing metadata U1 pinned:
`System.content`, `Assistant.content`, `AsstTools.content`,
`ToolResult.content`, `ToolResult.tool_call_id`, `AsstTools.tc.id`,
**`Reasoning.id` and the entire `Reasoning.summary` loop**,
`WS.Find.url`/`.pattern`, `WS.FindInPage.url`/`.pattern`, `WS.Search.query`,
`src.type`/`src.url`, `XSearch.id`/`.name`/`.input`,
`CodeInterp.id`/`.status`, and all six variant tags.

**Make the claim true.** Every framed contribution must be **either**:

- **pinned** by a test that fails when it alone is deleted, **or**
- **explicitly documented as structurally redundant**, with the argument for
  why no test can pin it.

No third category. A field that is neither pinned nor explained is the defect
this round closes. Produce the full 63-row accounting — field, disposition,
test name or redundancy argument.

Prioritise pinning: default to a pin, and use the redundancy exemption only
where you can argue it as rigorously as the two cases below.

## W2 [blocking] Two tests claim coverage they do not provide

Worse than a plain gap, because a reader sees the assertion and stops looking:

- **`raw_fingerprint_reasoning_summary_parts_do_not_collide`** asserts
  `"summary part boundaries and id must be framed"` — but its two fixtures
  differ in **both** `id` (`r1`/`r2`) **and** summary shape, so neither is
  individually pinned. This is why `Reasoning.id` and the whole summary loop
  are deletable with the suite green.
- **`pin_websearch_find_vs_find_in_page`** compares two **variants**, so
  deleting `Find.url` entirely still leaves the pair distinguishable.

De-confound both: vary exactly one thing per test. Then re-check whether the
fields they were supposed to cover are now genuinely caught.

## W3 [do not "fix"] The count fields are provably redundant — record the proof

Do **not** add tests for these and do **not** remove the fields. A verifier
established, and I accept, that:

- The counts are **derived** from the vector they precede, so "two items
  differing only in the count" describes **no constructible pair** — no test
  can pin them, in principle.
- Deleting a count leaves the encoding **injective anyway**: `push_framed` is
  length-prefixed so the field sequence is uniquely decodable, and each arm has
  fixed arity around its loop (`ToolResult` = 2 fixed + 2·k; `AsstTools` = 6
  fixed + 3·k + trailing content; `Reasoning`'s summary terminates on the
  literal `"summary_text"` tag, which can never equal the `"n"`/`"s"` presence
  bit that follows).

So their weaker pin creates **no false-negative risk**. Record that argument in
MAPPING.md as the redundancy exemption for all six counts (`images_count`,
`toolcalls_count`, `summary_count`, `content_count`, `User.content_count`,
`WS.sources_count`).

**Add the comment the verifier flagged:** the `Reasoning` case leans on
`"summary_text"` never colliding with `"n"`/`"s"`. True today; note it at the
code site so a future edit to either literal is caught.

## W4 [minor] `push_option_dbg`'s presence bit is inert — say so

Forcing the `None` arm of `push_option_dbg` to emit `"s"` **survives the full
suite**, because `Debug` output is never empty for those types, so `None`
(`|1:s|0:`) and `Some(v)` (`|1:s|N:v`) still differ on the value field. All
three `Option`s without an absent-vs-present pin — `User.cwd_generation`,
`prior_turn_interrupt`, `prompt_index` — go through it.

So the "missing" tests would pin a mechanism that does nothing there. **Do not
add them.** Document the distinction in MAPPING.md: `push_option_str`'s bit is
load-bearing and pinned; `push_option_dbg`'s is defence-in-depth and inert
given non-empty `Debug`. That asymmetry is exactly what the current doc gets
wrong by claiming uniform coverage.

## Severity note — for your own calibration, not to relax the work

`raw_fingerprint` feeds only `structural_divergence`;
`observe_serve_equivalence`'s return is discarded at `turn.rs:2145` (`let _ =`)
and `apply_serve_decision` has already run. A dropped field makes the
instrument **under-report divergence**; it cannot corrupt served output or
write-back. Every field is framed correctly **today** — what is missing is the
guard against future removal. That still matters, because Chunk 3's hook-4
removal ruling reads this instrument's output and a silent regression reports
zero divergences, which is indistinguishable from success.

---

## Report

Position against the full project. Lead with the **complete 63-row accounting**
— every framed contribution, its disposition (pinned / documented-redundant),
and the test name or argument. Then W2's de-confounded tests with
break-watch-restore output, and W3/W4's MAPPING.md text. Full suite counts,
both fmt gates, `--all-targets` clippy attributed. Vendored port, capture tee
and dedup semantics untouched.
