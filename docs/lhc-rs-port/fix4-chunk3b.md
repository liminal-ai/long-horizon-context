# Chunk 3B fix round 4 — scope the inference ruling, then close

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22. This closes Phase 3.**

N1–N4 landed and I verified them at source, not from your report:
`drain_derivations_before_compact` runs inside `LhcSession::compact`
(`session.rs:309`) — which is what `replace_compact_for_writeback` →
`compact_thread` reaches — bounded and fail-open. Tripwire green at 154 lib /
88 certification / 5 goldens / 10 harness, hooks 6/6, vendor untouched.

You were right to stop and report on ToolResultSummary rather than widening into
the port. Two items, both small.

---

## P1 [blocking] Record the ToolResultSummary scope decision

**Ruling as scoped: the inference ruling (`grok-4.5`, low thinking, native
sampler, real inference) governs derivation lanes that call inference at all.
Today that is PromptSmoothing. ToolResultSummary keeps the port's
truncate-fallback.**

Reasoning to record, not just the conclusion:

- The port sets `FORCE_TOOL_RESULT_SUMMARY_FALLBACK = true`
  (`handlers.rs:35`) and the internal call site passes `None` for opts
  (`handlers.rs:537`), so `use_inference` resolves false and
  `truncate_for_fallback` runs. The sampler is unreachable from the fork.
- **This is faithful to TS upstream** — the constant mirrors the TS private
  constant. The port is correct here, not defective.
- Reaching that sampler needs a port change (flip the constant, or thread
  `use_inference: Some(true)` through the call site). Either deviates from the
  TS parity Phases 1–2 certified, for one derivation lane. Not worth it without
  Lee choosing it explicitly.

Record in MAPPING.md and FORK.md: which lane does real inference, which
truncates, why, and the exact port change that would be required if the decision
is ever revisited — with file:line so nobody has to rediscover it.

**Add a test that pins the scoped claim honestly.** The counting-sampler test
should assert PromptSmoothing ops are non-empty **and** state in its name or
message that ToolResultSummary is expected absent by port design — so a future
reader does not read `[SmoothPrompt, SmoothPrompt, SmoothPrompt]` as "both lanes
fired". A test whose output implies more than it proves is the defect class this
project has hit five times.

## P2 [blocking] LIVE_RUNBOOK must state the derivation reality

L1's expected-output block currently implies both lanes exercise `grok-4.5`. Fix
it to say: PromptSmoothing probes hit `grok-4.5`; ToolResultSummary is
truncate-fallback by port design and will show no sampler op. Otherwise the
first live run reads a correct result as a failure.

While there: the runbook is the deliverable Lee executes. Re-read L1–L6 as if
you were running them cold with no context, and fix anything that assumes
knowledge you only have from building it.

---

## Then finish

After P1/P2, this chunk is done pending verification. Do not start anything new.
Report:

- final suite counts, both fmt gates, `--all-targets` clippy attributed
- hooks **6/6**, no seventh touchpoint, vendor pin `e582465` untouched
- the one-line summary of what a user gets today with `GROK_LHC=1` and
  `GROK_LHC_COMPACT=replace` + experimental flag, and what remains live-only

If anything here needs a port change or a seventh hook, **stop and report** —
that is the whole point of P1.
