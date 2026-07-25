# Chunk 2 fix round 12 — the instrument is miscalibrated for tool windows

**Chunk 2 of 3, Phase 3 of 4 — unit 17 of ~22.**

**Q1–Q3 are confirmed fixed**, and confirmed the hard way: both verifiers
independently re-ran the mutations rather than accepting your evidence. One
appended misformatted probes to *both* crates and watched the tripwire trip on
each gate separately with real diffs and exit 1; both re-ran the band mutation
and saw the two new negatives fail while the positive stayed silent, exactly as
designed.

**Q4's kind conservation is confirmed real** — the round-trip test drives a live
capture, the real `get_classify_context`, real `replace_history`, then re-reads
event kinds. Both documented exceptions were checked against the sink types and
are genuinely forced: `ToolResultItem` has only `tool_call_id` / `content` /
`images` (the source `SessionToolResultMessage` *does* carry `is_error` and
`tool_name`, so it is the host type that drops them), and `ConversationItem` has
no model-change or thinking-change variant. `prompt_index` cannot be displaced —
every new kind lands outside the real-`User` set, and the marker namespaces are
disjoint. Orphaned tool calls are handled downstream by the host's own request
conversion.

Three items remain, two of them in the equivalence instrument — which is the
**evidence base for Chunk 3's hook-4 removal ruling**, so it must be right
before Chunk 3 starts collecting.

---

## R1 [blocking] Informational divergence fires on cosmetic JSON in every tool window

Capture parses tool arguments into an object
(`parse_arguments_object`, `mapping.rs:272`). `emit_assistant_conserved`
re-serializes them with `Value::Object(m).to_string()` (`serving.rs:333`) —
**compact**. Native `ToolCall.arguments` holds the provider's **raw bytes**
(`conversation.rs:1679`; `sanitize_tool_arguments` only validates). The
canonical projection deliberately preserves internal whitespace, so the two
differ byte-wise on every tool window that has any spacing:

```
native : {"cmd": "ls", "timeout_ms": 5000}
served : {"cmd":"ls","timeout_ms":5000}
structural=false  informational=true
```

**This is the inverse of the documented contract.** The actionable channel
fires while the raw channel stays silent, on a difference that carries no
information. Left as-is, Chunk 3's live cert would accumulate informational
divergences on every tool-using session and the "zero divergence ⇒ remove hook
4" criterion would never be evaluable.

Key *order* is safe — the vendored port enables `serde_json/preserve_order`,
unified workspace-wide. It is byte *formatting* only.

**Fix:** canonicalize tool-call arguments identically on both sides before
comparing — e.g. parse both and re-serialize compact within the projection, so
formatting cannot register while a genuine argument change still does. Do not
fix it by dropping arguments from the projection; an argument change is exactly
what the instrument must catch.

**The existing tests structurally cannot catch this.**
`equiv_tool_window_structural_only` builds `served` by projecting `native` and
mapping back, so the argument string is identical by construction and the
re-serialization path is never exercised;
`equiv_post_writeback_band_collapse_informational_silent` has the same blind
spot — both sides come from the same translator. Add tests where the two sides
arrive by **genuinely different paths**, and assert: cosmetic formatting
difference ⇒ **silent**; real argument difference ⇒ **informational
divergence**.

## R2 [blocking] `raw_fingerprint` is blind to tool-call identity

`raw_fingerprint` (`equivalence.rs:249-266`) is
`format!("{kind}:{}", item.text_content())`. For an assistant item with empty
text and non-empty `tool_calls`, that is the **constant** `"assistant_tools:"`
— tool name, call id and arguments are all invisible. Structural comparison
therefore cannot distinguish two different tool calls, and cannot see a tool
call being replaced by a different one.

That is a hole in the raw channel precisely where R1 makes the projected
channel over-sensitive: the instrument is loud where it should be quiet and
silent where it should be loud. Include tool-call identity — name, id,
argument shape — in the fingerprint, and test that swapping a tool call
registers structurally.

## R3 [minor] FORK.md numstat drift

FORK.md declares `compaction.rs` as `+182/-1`; the comparison against
`origin/main` reports `181/1`. Re-verify every carve-out numstat against
`origin/main` and correct the table.

---

## Standing requirements

Both new behaviours in R1 and R2 need **break-watch-restore** with captured
output — that standard now applies to every new test. Re-run the five gate
properties, since R1/R2 touch the comparison path.

## Report

Position against the full project. For R1–R3: fixed / not fixed and why. For
R1, state the canonicalization you chose and prove it distinguishes a **real**
argument change from a cosmetic one, using tests whose two sides arrive by
different paths. For R2, show a swapped tool call registering structurally.
Report full suite counts, both fmt gates, `--all-targets` clippy attributed,
and confirm the vendored port, capture tee and dedup semantics are untouched.
