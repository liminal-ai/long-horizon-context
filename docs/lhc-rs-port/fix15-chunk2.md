# Chunk 2 fix round 15 — pin the framing invariants

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Round 14's audit is **substantively correct** — a verifier attacked every arm
independently in an isolated tree and could not break the claim the code makes.
Full regression is green: 71 lib + 71 certification + 5 goldens, no ignored
tests, both fmt gates, clippy clean with all 40 warnings in the vendored port.

The problem is not the code. It is that **none of the code is pinned.**

---

## U1 [blocking] Fourteen framing fields survive deletion untested

A verifier deleted each framing field from `raw_fingerprint` one at a time and
ran the full 147-test suite. **All fourteen survived:**

```
User.synthetic_reason          User.cwd_generation
User.prior_turn_interrupt      User.prompt_index
Assistant.model_id             Assistant.reasoning_effort
ToolResult.images_count        AssistantTools.toolcalls_count
XSearch.call_id                CodeInterp.container_id
Reasoning.status               Reasoning.content_count
WebSearch.sources_count        Reasoning.summary_count
```

The pattern is exact and worth internalising: **the two arms you were told to
fix got tests; the arms you hardened as a precaution got none.** Neither did
`XSearch`, `CodeInterpreter`, or the `OpenPage`/`Find`/`FindInPage` variants.
`MAPPING.md` maintains a Test | Expect contract table; round 14 added
invariants to the code and rows to neither the table nor the suite.

**Why this is blocking rather than "the code is fine".** Chunk 3's live
certification consumes this instrument's output as the evidence for a
touchpoint-removal ruling. If framing silently regresses, the instrument
reports **zero structural divergences** — and zero is indistinguishable from
success. That is a false negative on exactly the signal the ruling depends on.

**Fix:** one test per framing field, each asserting that two items differing
**only** in that field produce different fingerprints. Fourteen minimum, plus
the arms with no coverage at all. Add the corresponding rows to MAPPING.md's
Test | Expect table.

**Prove it the way it was found:** delete each field in turn and confirm the
matching test fails. Report the field→test mapping and the deletion results as
a table. If any field cannot be pinned, name it and say why.

## U2 [blocking] `Option` absent-vs-present-empty collides — fix it, don't carry it

Six sites where the field *is* framed but through a **non-injective
projection** (`Option<T>` flattened to `T::default()`), so absent and
present-empty share a fingerprint:

```
reasoning.encrypted   None == Some("")
reasoning.content     None == Some([])
websearch.sources     None == Some([])
assistant.model_id    None == Some("")
codeinterp.code       None == Some("")
openpage.url          None == Some("")
```

These are **wire-visible** differences — `skip_serializing_if` omits the key
entirely. Note `CodeInterpreter.outputs` is the one `Option` handled correctly,
via `serde_json` (`null` ≠ `[]`); make the rest consistent with it.

The verifier classified this **carryable** with a named Chunk 3 checkpoint,
because reachability is bounded: the serve translator never emits
`BackendToolCall` (ruling out three sites), and serving's `Reasoning` is always
the fixed `synthesized_reasoning_item` shape. **I am overriding that to fix it
now.** The fix is a presence bit (`"s"`/`"n"`) framed before each flattened
`Option` — minutes of work in a round already running — whereas carrying it
costs a named checkpoint plus sustained vigilance in Chunk 3, and depends on an
emission surface staying narrow. Cheap to fix, expensive to remember.

Test absent-vs-present-empty for **every** `Option` in the fingerprint, not
only the six found.

## U3 [minor] Two documentation corrections

1. **`MAPPING.md:419`** — "framing is injective over the fields that are framed"
   is **literally falsified** by U2: the fields are framed; the projection is
   not injective. Restate precisely — injective over the framed field
   *projections*, with the `Option`-flattening rule named — and phrase it as the
   invariant a future reader must preserve when adding a `ConversationItem`
   variant or a new `Option` field.
2. **`FORK.md:48`** — the carve-out table omits
   `crates/codegen/xai-grok-shell/src/session/acp_session_tests/rewind_cross_compaction_tests.rs`
   (`+224/-0`). Test-only and additive, but the table claims to record **every**
   core touchpoint, and I independently hit this while preparing the
   `patches/` regeneration: the file is core-tree, so a history-reset recovery
   that misses it loses the H3 regression test. Add it.

---

## Report

Position against the full project. Lead with U1: the field→test mapping table
and the deletion result for each, in the same shape the verifier used. Then U2
with the presence-bit encoding and the absent-vs-empty tests. Then the doc
corrections. Full suite counts, both fmt gates, `--all-targets` clippy
attributed. Confirm the vendored port, capture tee and dedup semantics are
untouched.
