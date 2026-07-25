# Chunk 2 fix round 14 — the last two fingerprint arms

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

S2 and S3 **passed both verifiers**, with independent traces:

- **S2** — recursive object-key sorting is silent on both channels, keys inside
  arrays are sorted, array element order stays divergent, and value / key
  add-remove-rename / type / nesting changes all still fire. The instrument-only
  claim was **traced, not grepped**: canonicalized strings reach only
  projections, fingerprints, comparison reports and diagnostic logs. The shell
  applies `decide_substitution` before observation, and write-back independently
  uses `build_writeback_conversation`, so no canonicalized value is returned to,
  persisted by, served by, or written into a real conversation body.
- **S3** — the served side genuinely traverses the production translator;
  breaking `emit_assistant_conserved` fails the test.

The framing mechanism in S1 is also correct and was adversarially probed by
both: `len` is **bytes** not chars (`é🙂` → `6:é🙂`), tags are prefix-safe, and
multi-tool boundary shifts, empty fields, `len:bytes`-shaped payloads,
delimiter-heavy fields, empty `tool_calls` vs assistant text, and tool-result
image count/order/type all stay distinct.

**One defect remains, and both verifiers reproduced it independently.**

---

## T1 [blocking] Two arms frame a lossy aggregate, so distinct items still collide

The framing is injective over *field sequences*. It cannot help when the
**field itself** is already a lossy summary. Two arms
(`equivalence.rs:305`-ish) frame `item.text_content()` — an aggregate that
discards typed fields:

**`BackendToolCall`** — two web-search calls with different ids (`ws_a`, `ws_b`)
but the same query collide:

```
backend_tool_call|39:[backend web_search] search: same query
```

`text_content()` omits the backend call **id**, **status**, **sources**, and the
other typed fields.

**`Reasoning`** — these two distinct items collide:

```
id "r1", summary parts ["a", "b"]
id "r2", summary parts ["a\nb"]
→ both:  reasoning|3:a\nb
```

The aggregate omits the reasoning **id**, **encrypted content**, and **status**,
and part boundaries vanish because the parts are joined before framing.
**Encrypted-only reasoning items collapse to the same empty fingerprint.**

Both were reproduced as failing tests, exit 101.

**Severity: this is the under-reporting direction** — a real structural
difference reads as identical, which is what would wrongly justify removing
hook 4. It is blocking and must not be carried into Chunk 3.

### Fix

Frame the **typed fields**, not the rendered summary, for both arms — the same
treatment `assistant_tools` and `tool_result` already received:

- `BackendToolCall`: id, kind/name, status, query/arguments, and sources —
  frame each field separately, and frame the source **count** before the
  sources so a differing count cannot be absorbed.
- `Reasoning`: id, status, encrypted content, and the summary parts framed
  **individually with a leading count**, so `["a","b"]` and `["a\nb"]` cannot
  render alike.

Audit the remaining arms for the same mistake rather than fixing only these
two: any arm still framing `text_content()` where the item carries typed fields
beyond that text has the same latent flaw. This is the second time a fix
addressed the arms where a collision was demonstrated and left an identical
flaw elsewhere.

### Tests

- Both verifier collision pairs, as failing-under-old-scheme tests.
- Encrypted-only reasoning items with different encrypted payloads must differ.
- A backend call differing **only** in `status`, and one differing **only** in
  `sources`, must each register.
- Break-watch-restore with captured output for each.

## T2 [minor] MAPPING.md overstates injectivity

MAPPING.md states the fingerprint is injective. That was inaccurate while these
arms framed aggregates. Correct it, and state the property precisely: framing is
injective **over the fields that are framed**, so every arm must frame its typed
fields rather than a rendered summary. Phrase it as the invariant a future
reader must preserve when adding a `ConversationItem` variant.

---

## Report

Position against the full project. Lead with T1: the field list you framed for
each arm, the audit of every remaining arm, and break-watch-restore output for
each new test. Full suite counts, both fmt gates, `--all-targets` clippy
attributed. Confirm the vendored port, capture tee and dedup semantics are
untouched.
