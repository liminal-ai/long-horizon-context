# Chunk 2 fix round 13 — fingerprint injectivity and instrument sensitivity

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

Split verdict: one verifier passed the chunk, the other found three real things.
I adjudicated against source rather than by vote, and the second is right on all
three. This is why the final gate stayed dual.

**Confirmed good and not in scope:** R1's JSON canonicalization is genuinely
correct on semantics — an independent probe showed value change, key
add/remove/rename, nesting change, nesting *depth* change, type changes
(`5000` vs `"5000"`, `true` vs `"true"`, `null` vs `""`), array reordering and
`5000` vs `5000.0` **all** fire on both channels, while pretty-vs-compact and
tabs/newlines are silent on both. R3's numstats verified against `origin/main`.
Five gate properties pass. No ignored tests. Clippy attribution clean.

Three items.

---

## S1 [blocking] `raw_fingerprint` is not injective — a real difference can read as identical

`raw_fingerprint` (`equivalence.rs:264-300`) concatenates fields with `:` and
`;` delimiters and **no escaping or length framing**. Verified at source:

```
assistant_tools:{name}@{id}:{canonical_args};…:{content}
```

so these two distinct items produce the **same** fingerprint:

```
args = "x:y",  content = "z"     → assistant_tools:n@i:x:y:z
args = "x",    content = "y:z"   → assistant_tools:n@i:x:y:z
```

Reproduced by a verifier as a failing test. It is reachable precisely because
R1 deliberately lets **non-JSON arguments pass through unchanged**, so an
argument string may contain the delimiters.

**Severity: this is the silent direction.** A collision makes a genuine
structural difference read as *identical*, and Chunk 3's ruling is "zero
divergence ⇒ remove hook 4." An instrument that can under-report divergence is
worse than one that over-reports, because the false conclusion is the one that
removes a touchpoint.

`ConversationItem::ToolResult` has the same shape —
`tool_result:{tool_call_id}:{content}` — and the same flaw. Audit **every** arm
of the match, not just the two named.

**Fix:** make the encoding injective. Length-framing each field (e.g.
`len:bytes`) or hashing a structured serialization both work; delimiter
escaping works if applied to every field including content. Whatever you pick,
prove injectivity with a test that would fail under the current scheme — the
verifier's collision pair is the obvious starting case, and add one for
`tool_result`.

## S2 [blocking] Key reordering must be silent — ruling

The vendored port enables `serde_json/preserve_order` workspace-wide, so
`{"a":1,"b":2}` and `{"b":2,"a":1}` currently register as divergence on both
channels.

**Ruling (mine, recorded here): reordering is cosmetic and must be silent.**
JSON object key order carries no information, so a reordered payload is the
same payload. More importantly this is the same failure mode as R1 — an
over-sensitive actionable channel means Chunk 3's live cert accumulates
divergences that mean nothing, and the removal criterion becomes unevaluable.

Canonicalize with **sorted keys** for comparison purposes. Note carefully: this
canonicalization is **instrument-only**. It must not change the written-back
body, the served body, or anything persisted — only what the equivalence
comparison sees. State explicitly in your report that you verified this.

Array order must **stay** significant (arrays are ordered by definition; the
probe above correctly fires on `[1,2]` vs `[2,1]`). Test both: reordered object
keys silent, reordered array elements divergent.

## S3 [blocking] The "different paths" tests still do not exercise the translator

Round 12 claimed the two comparison sides are built by genuinely different
paths. They are not: both are hand-built `ConversationItem::Assistant` values
(`certification.rs:2736`). Different literals is not different translators —
the real serving path, `SessionThreadView → emit_assistant_conserved →
ConversationItem`, is never exercised, which is the exact blindness that hid R1.

Rebuild these so the **served** side comes through the real translator from a
`SessionThreadView`, and the **native** side is a native-shaped body. Then the
cosmetic-vs-real distinction is being tested where it actually happens.

This is the fourth time in this chunk a test has passed while not binding to
the production path. Apply the standard: break the production code the test
claims to guard and show the failure.

---

## Standing requirements

Break-watch-restore with captured output for every new or rebuilt test in S1–S3.
Re-run the five gate properties. Full suite counts, both fmt gates,
`--all-targets` clippy attributed. Vendored port, capture tee and dedup
semantics untouched.

## Report

Position against the full project. Lead with S1 — the encoding you chose, why
it is injective, and the failing-under-old-scheme test for both
`assistant_tools` and `tool_result`. Then S2, including your explicit
confirmation that the sorted-key canonicalization is instrument-only and cannot
reach any persisted or served body. Then S3, with the rebuilt tests and their
break-watch-restore output.
