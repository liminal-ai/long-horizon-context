# Chunk 2 fix round 11 — acceptance blockers

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

**The design is ratified and confirmed.** Both acceptance verifiers returned
**DESIGN: SOUND** on provenance-based classification, and Opus argued it is not
merely sound but *forced* — on the public typed view the only discriminators
are the entry variant (identical for prompts and runtime notes),
`source_messages` (identical shape), and the rendered text prefix; once the
prefix is forbidden, `message_id` provenance is the residual. A mechanical
sweep found **zero surviving content-keyed rules** in the classifier. That
question is closed; do not revisit it.

Four blockers before Chunk 2 is accepted.

---

## Q1 [blocking] Whole-index failure silently demotes every real prompt

`get_classify_context` (`session.rs:232-250`) turns a `messages.list` **error**
into an **empty** `SourceKindIndex` and returns success. Both verifiers found
this independently, and it is the most dangerous item in the chunk.

"Fail toward synthetic" is correct at **per-entry** granularity — one
unresolvable source should not be promoted. It is catastrophic at **whole-index**
granularity: with an empty index, *every* real prompt classifies synthetic, so
serving substitutes a body with **no real user turns**, write-back erases
**every** `prompt_index` marker, and the tee recaptures the user's actual
prompts as `runtime_note`. Silent, total, and it corrupts the canonical record.

It also contradicts the serving contract: `serve_request_context`
(`lib.rs:132`) is documented as *any error ⇒ Native*.

**Fix:** an unavailable classifier aborts the translation. Index failure must
propagate as an error — serving falls open to Native, write-back does not
proceed — never a silently empty index. Keep per-entry unknown ⇒ synthetic
exactly as it is; the two granularities need different answers.

Test both: a per-entry unknown stays synthetic; a whole-index failure fails
open and performs **no** substitution and **no** write-back.

## Q2 [blocking] Both formatting gates fail

`cargo fmt -p xai-grok-shell --check` fails (`compaction.rs:1896`), and
`cargo fmt --check` on the adapter fails across `lib.rs`, `serving.rs`,
`session.rs` and the certification tests. These are named gates and both have
been reported clean while failing.

Fix the formatting, and **add both `fmt --check` invocations to
`scripts/check-lhc-hooks.sh`.** The tripwire missed a red unit suite for two
rounds until I added `--lib`; it has the same blind spot for formatting. A gate
that does not run a check cannot report on it.

## Q3 [blocking] Band-collapse sensitivity is not demonstrated

Sol mutation-tested the projection: replacing every band run with a constant
`"[bands]"` left **both** relevant tests passing —
`equiv_post_writeback_band_collapse_informational_silent` and
`band_collapse_aligns_writeback_and_serving`.

The production code is right (it joins exact bytes, so it *would* detect a
missing or reordered band), but the tests only prove that equal bands compare
equal. Add the negative tests: a **missing** band and a **reordered** band must
each register informational divergence. Demonstrate break-watch-restore on
them.

## Q4 [blocking] Conserve typed kinds through write-back — but only in the tail

Sol found the runtime-note fix does not generalise. The shared translator also
converts, in `serving.rs:263-290`:

- `ToolResult` → `user_meta` → recaptured as `runtime_note`
- `ModelChange` / `ThinkingLevelChange` → `user_meta` → `runtime_note`
- assistant **tool calls and thinking** → flattened `Assistant` text →
  `assistant_text`

So write-back adds semantically duplicated records under the wrong kinds. This
is the same canonical-record concern as P1, one layer out.

**It is not forced.** The host has the variants:
`ConversationItem::ToolResult(ToolResultItem)`
(`conversation.rs:37`), and `Assistant` carries real `tool_calls`. The session
view carries what is needed to rebuild them — `SessionToolResultMessage` has
`tool_call_id`, `tool_name`, `content`, `is_error`, and `SessionAssistantPart`
carries the assistant part detail.

**The principled boundary, and the rule for this round:**

- **The compressed prefix (bands) legitimately becomes `user_meta`.** That is
  what compaction *is* — old turns are deliberately rendered to prose, and
  reconstructing structure there would be inventing it.
- **The live tail must conserve kinds.** The tail is full-fidelity by
  construction, so a tool result must write back as a `ToolResult` item, an
  assistant tool call as a real `tool_calls` entry, and a model/thinking change
  as whatever the host natively uses. Round-trip integrity must hold for
  **every** kind in the tail, not just `runtime_note`.

This also removes a real fidelity loss: today the written-back body replaces
structured tool-use history with prose on the **persisted** conversation, so
the provider's tool-calling protocol — call ids matched to results — degrades
to narrative text. Preserving it is strictly better for the model, not just for
the record.

Constraints:

- Do **not** reconstruct structure for band content. If you cannot rebuild a
  tail item faithfully from the typed view, keep it as `user_meta` and **report
  which kind and why** — do not guess.
- Re-run the five gate properties: this changes the body shape, so fixpoint,
  `prompt_index` assignment and the equivalence comparison all need
  re-checking on a fixture containing a tool result, an assistant tool call, a
  model change and a runtime note.
- Generalise the round-trip test: an item entering capture as kind K must still
  be kind K after write-back, for every K reachable in the tail.

**If conserving a particular kind turns out to be genuinely impossible from the
typed view, stop and report that kind specifically** — that is an SDK-boundary
finding, not something to approximate.

---

## Report

Position against the full project. For Q1–Q4: fixed / not fixed and why. Lead
with Q4 — the kind-conservation table (which kinds now round-trip, which stay
`user_meta`, and why), and the generalised round-trip test with
break-watch-restore output. Then Q1's two-granularity behaviour, the fmt gates
plus the tripwire additions, and the band negative tests. Report full suite
counts and confirm **both** `fmt --check` invocations pass. Confirm the
vendored port, capture tee and dedup semantics are untouched.
