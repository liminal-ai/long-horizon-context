# Phase 4 / Chunk 1 — fix round 3

Resume the same session. Same rules: **do not commit, do not push**.
Position: **Chunk 1 = unit 20 of 22**, capture only; Chunks 2–3 remain and
are the larger part.

Round 2's fixes for F7/F8 and F17 **made things worse than the defects they
replaced**. Two independent confirmers reproduced this with probes. Read
this round differently from the last two: the individual bugs matter less
than the pattern producing them.

---

## Rule zero — the pattern, and the rule that ends it

Round 1's F4, round 2's F7/F8, and round 2's replacement queue test are the
**same defect**: a hard invariant asserted against a **pure function**
(mapper output, or a hand-built tracker) and never exercised **through the
production path** into LHC storage.

`mapping_goldens_per_variant` compares mapper output to mapper-derived
goldens. `arguments_raw_byte_exact_cases` and `image_url_not_truncated_in_extra`
are mapper-only. Not one of them submits through `LhcSession`. That is why a
change that causes LHC to **reject every affected event and permanently
disable the thread** passed the entire suite plus a golden byte-gate.

**Rule zero, binding for the rest of this chunk:** every test that certifies
what LHC *records* must submit through a real `LhcSession` and **read the
stored row back**. Mapper-only assertions are permitted only as an addition
to a round-trip test, never as the sole guard. When you finish, list any
remaining capture invariant that is guarded only by a pure-function
assertion — I expect that list to be empty, and I will check it.

---

## H1 (BLOCKER) — `extra` is rejected by LHC; move the payload, do not keep the field

`mapping.rs:191,211,246,358,638,641`. `MessageEventInput.extra` is
`#[serde(flatten)]` and documented as *"Unknown envelope fields (strictness
probes)"* — a strictness-test escape hatch, **not a storage slot**. I
verified the vendored port myself: `intake_stream/internal/validate.rs:359-372`
declares the envelope schema as exactly
`eventKind | idempotencyKey | actor | harness | payload`, and any other key
fails the whole batch. Nothing in `pipeline.rs` ever reads `extra`.

Reproduced by a confirmer:

```
PROBE submit#0 -> Err("LHC message_events failed (class=CallerError code=InvalidEvent):
  event: \"argumentsRaw\" is unexpected, expected:
  \"eventKind\" | \"idempotencyKey\" | \"actor\" | \"harness\" | \"payload\"")
PROBE capture_disabled = true
PROBE stored events = 1   ← of 3 submitted
```

Real-session consequence: the model's first `FunctionCall` is rejected
(`failure_count=1`); by the third tool call `capture_disabled` latches and
the thread is dark for its lifetime. This hits `FunctionCall`,
`CustomToolCall`, `ToolSearchCall`, `AgentMessage`, `AdditionalTools`, and
every message or tool output carrying an image or audio — the majority of a
real transcript. Image capture is now strictly worse than before the F8
"fix": previously truncated-but-recorded, now destroyed.

**Fix:** carry verbatim `arguments`/`input` and full media **inside
`payload`**, which is `Schema.Unknown` and free-form by contract. Never
populate `extra` from the host — it is not ours. Then satisfy rule zero:
round-trip every affected variant and assert on the **stored row**.

## H2 (BLOCKER) — the F17 open window systematically swallows the session's first items

`install.rs:326-337`. Reproduced: `on_thread_start` returns in ~57 µs having
only spawned a thread; the handle is not ready for **~67 ms**. Items arriving
in that window are dropped with a `warn` and nothing else.

```
PROBE on_thread_start returned in 56.695µs
PROBE handle ready at 66.784821ms
PROBE events captured = 0 (expected 2)
```

`Session` construction records `build_initial_context_with_world_state` items
microseconds later (`core/src/session/mod.rs:3812`) — always lost. In
`codex exec` the **first user prompt** lands in the same window: the single
most load-bearing event for Chunk 2's banded compaction, dropped silently and
systematically. The first `on_config_changed` is swallowed too
(`install.rs:365` returns with no warn when the handle is absent).

Every existing test calls `wait_for_handle` first, so the race is
unreachable from the suite **by construction** — which is why it shipped.

**Fix:** do not drop. Buffer items arriving before the handle is ready and
flush them on open (bounded, with the same degraded policy on overflow), or
make open synchronous enough to be ready before the first record. F17's
requirement was "do not block the critical path", not "lose the opening of
every session". Test the race **without** `wait_for_handle`.

## H3 (BLOCKER) — the production registration site still has zero coverage

`app-server/src/extensions.rs:119`. This `codex_lhc_host::install(...)` is
what connects capture to TUI and exec. **No test references it.** A confirmer
wrapped it in `if false { … }`, keeping the sentinel comment:

```
SENTINEL COUNT WITH REGISTRATION DISABLED: 28 (EXPECTED_HOOKS=28)
test result: ok. 2 passed; 0 failed   ← both e2e tests
```

So an upstream merge that drops the call leaves sentinels 28/28, all tests
green, `ALL TRIPWIRES GREEN`, and **no capture in any real frontend**. F11
was raised precisely because a sentinel proves a comment, not a call; the
e2e test closed the *core* seam and left the *host* seam in the condemned
state one layer up.

**Fix:** a test that builds the registry through the real
`thread_extensions(...)` path (or asserts the registry produced by it
contains an LHC raw-item contributor when the flag is on, and none when off)
and fails when the `install(...)` call is removed. Prove it by removing the
call and pasting the failure.

## H4 (BLOCKER) — the F5 replacement test is vacuous by construction

`tests/certification.rs:517`, branch at `:539-550`. The test reads
`if dropped > 0 { real assertion } else { assert!(!is_degraded()); assert_eq!(dropped, 0) }`
— the `else` arm asserts the *absence* of the condition under test. A
confirmer deleted both the drop counter and the degraded latch; it still
passed.

**Fix:** force saturation deterministically so the drop branch is guaranteed
(block the worker, then overfill), and assert unconditionally. No
`if`-guarded assertions in a certification test — if the setup cannot
guarantee the condition, the test is not certifying it.

## H5 (MAJOR) — same id + evolved content silently keeps the stale version

`idempotency.rs:150-157`. The id-primary key carries **no digest**, so two
records of the same `ResponseItemId` with different content collide and LHC
skips the second. An `ImageGenerationCall` recorded at
`status=in_progress, result=""` and again at
`status=completed, result="…"` leaves only the in-progress version durably.
Affects the server-id-bearing variants (`WebSearchCall`,
`ImageGenerationCall`, `ToolSearchCall`).

This is a **real trade**, not obviously a bug: content in the key restores
the round-1 restart double-record. Decide it explicitly and defend it in the
module doc (which currently argues only the restart direction). If you keep
id-primary, the mutation case must be handled deliberately — e.g. include a
content digest **only** for the variants whose status advances, or record
the terminal state only. Round-trip test either way.

## H6 (MAJOR) — `degraded` latches irrecoverably and invisibly

`capture.rs:73-96,335-341`. One `Full`, one `Closed`, or three submit
failures latch for the thread's life, with no unlatch, no user-visible
surface, and **nothing written into the LHC record**. For Chunk 2's
write-back a silently truncated thread is *worse* than a lossy one: it is a
complete, well-formed, internally consistent prefix that stops at an
arbitrary point with no marker, and Chunk 2 will rebuild a history that
confidently omits everything after the latch.

**Fix:** on latch, submit a `runtime_note` recording the truncation *before*
refusing further work, so the record is self-describing. Round-trip test it.

## H7 (MAJOR) — `model_change` ordinals are not restart-stable

`idempotency.rs:21-27`, `session.rs:120`, test at `certification.rs:741`.
G1 required restart stability; the scheme is high-water ordinal seeding —
exactly what F1 established is *not* restart-stable, reintroduced on a second
path. The test only asserts a genuinely new transition gets a fresh ordinal
(trivially true). The comment at `:736-739` asserts the host does not re-fire
historical config diffs on restart, with no citation and no test;
`refresh_runtime_config` (`core/src/session/mod.rs:1642`) is a plausible
re-fire path on resume.

Either derive a restart-stable key (from the transition itself: prev→new
values plus a stable ordinal source), or prove the no-re-fire premise with a
test and cite it. Do not leave an unguarded assertion.

## H8 (MAJOR) — crash parameterization missing the case the comment claims

`certification.rs:394-395`: the comment says injection points 0, 1, 2; the
loop runs `[0, 1]`. `after=2` — crash after both events are submitted but
before the worker acknowledges — is the closest analogue to a real mid-flush
kill and is the one not run. Run it, and make the comment true.

## H9 (MINOR, all of these)

- **Worker panics are uncontained** (`capture.rs:296-404`): a panic in
  `map_item` kills the worker thread, closes the channel, and turns every
  later `persist` into `Closed` → `degraded`, on one `warn` line. The core
  boundary's `catch_unwind` is sound but does not cover this. Contain it and
  drive a panicking item through the worker in a test.
- **Five goldens certify unreachable shapes**
  (`function_call`, `custom_tool_call`, `tool_search_call`, `agent_message`,
  `additional_tools` — each has a non-empty `extra`). After H1 they must be
  regenerated from round-tripped, actually-stored rows.
- **Tripwire does not neutralize `UPDATE_LHC_GOLDENS`**
  (`check-lhc-hooks.sh:71-78`): if set in the environment, the golden test
  rewrites fixtures and skips comparison while the header claims they are
  byte-checked. Use `env -u UPDATE_LHC_GOLDENS`.
- **`cwd` dropped at open** (`install.rs:178`): `spawn_capture(&thread_id,
  None, …)` always passes `None` though `ThreadStartInput.config` carries it.
  Chunk 2/3 will want it.
- **Stale test binaries**: a confirmer found a cached certification binary
  containing a symbol present in no source file. Run
  `cargo clean -p codex-lhc-host` before your final verification run.

---

## Re-verification standard (unchanged, and now rule-zero-bound)

Every fix lands with a test that fails when the fix is reverted, **and** that
test round-trips through `LhcSession` where it certifies stored content.
Report actual break-it output per item. Re-run the tripwire and paste it.
Keep FORK.md, `EXPECTED_HOOKS`, and `patches/lhc/` in lockstep.

## Report

Per finding: what changed, `file:line`, the round-trip test, its break-it
output. Then the rule-zero audit list (capture invariants still guarded only
by pure-function assertions). State the 22-unit position and what remains.

---

# Second confirmer — additional findings, and orchestrator adjudications

The second lane independently reproduced H1–H4. Its additions follow, with
my rulings where the two lanes disagreed. **Rulings are final for this
round.**

## H10 (MAJOR) — provenance is mislabeled at the real model-output sites

`core/src/stream_events_utils.rs:96` (`record_completed_response_item_with_finalized_facts`
— the *primary* model-output recording path) and `core/src/compact.rs:717`
both call the **generic** `record_conversation_items`, which defaults to
`HostContext` (`session/mod.rs:2982`). So completed model responses and
compaction output are labelled `HostContext`, not `ModelOutput`.

**Adjudication — the lanes disagreed and both were partly wrong.** One lane
reported the tagging correct at every call site; it missed these two. The
other reported that "typed provenance is therefore false at real call
sites", implying corrupted output. Checking `mapping.rs:503` myself:
assistant-role items map to `assistant_text` **regardless of provenance** —
provenance only gates the `role == "user"` branch. So there is **no runtime
corruption today**; model output is recorded correctly by virtue of its role.

What is genuinely wrong: the label is false, and **provenance correctness is
untested** — a confirmer changed the fallback to `UserPrompt` and both core
e2e tests plus the golden test still passed. A latent mislabel that nothing
guards is precisely how law 6 defects return.

Fix: tag those two sites explicitly (`ModelOutput`, and the right value for
compaction output), and add a test that fails when a provenance tag is
changed. Do not claim runtime corruption in your report — there is none.

## H11 (MAJOR) — the resume-order test is vacuous

`core/src/session/lhc_capture_e2e_tests.rs:98`. It never closes or reopens,
**sorts by `event_order` before asserting the order is increasing**, and
never checks prompt identity. It cannot fail. F14 is not fixed.

Fix: capture → close → reopen → assert the recorded prompts appear in the
original order *by identity*, without pre-sorting.

## H12 (MAJOR) — F1's "production restart" test bypasses the production path

`tests/certification.rs:45`. It manufactures and reuses a synthetic id
instead of driving core's mint → rollout → resume path, so a regression in
which core mints **fresh** ids on replay would duplicate every record while
this test stayed green. This is rule zero again, one level up: round-tripping
through `LhcSession` is necessary but not sufficient where the invariant is
about **core's** behavior.

Fix: exercise real id assignment via core (`prepare_conversation_items_for_history`
→ persist → resume), not a hand-made id.

## H13 (MAJOR) — the config-change test bypasses core's fan-out

`tests/certification.rs:661` calls registry contributors directly rather than
going through `Session::emit_config_changed_contributors`. A confirmer
replaced the core fan-out iterator with `.take(0)` and the config test plus
both e2e tests stayed green. Same class as H3.

## H14 (MAJOR) — unwind containment has no test

`core/src/session/mod.rs:3320`. Removing the containment entirely left both
core e2e tests passing. Also note: `catch_unwind` gives no **timeout**, so a
contributor that stalls still blocks conversation recording indefinitely.
Add the panic test; state explicitly whether you are accepting the stall
risk (contributors are `try_send`-only by contract) or bounding it.

## H15 (MINOR) — remaining test-faithfulness gaps

- `certification.rs:554`: the anonymous-path test injects an id-less
  `Message` directly, but core assigns ids to every mappable variant — the
  only intrinsically id-less variants (`CompactionTrigger`, `Other`) map to
  no events. I verified this myself (`protocol/src/models.rs:1097`). Either
  make the fixture host-faithful or document the anonymous path as an
  unreachable fallback and test it as such.
- `certification.rs:394`: the crash parameterization also uses
  `ImageGenerationCall`, whose two events have **different kinds**, so it
  does not exercise the part-suffix path that same-kind events (reasoning
  summary + encrypted) need. Cover a same-kind multi-event item too.

## H16 (deferred, do NOT act on this round) — module and change size

One lane flagged `mapping.rs` (1,003 lines, 344-line dispatcher) and the
780-line certification file as exceeding repository review thresholds, and
the 4,036-line change as unbisectable. The finding is fair and matters for
the eventual upstream PR of `RawItemContributor`.

**Ruling: deferred to a dedicated pass after Chunk 1 is accepted.** Splitting
modules in the same round as six blocker fixes maximises the chance of a
seventh. Recorded in FORK.md's scheduled-verification table as
"module split + change-set decomposition before upstream PR candidacy".
Do not restructure now.

## Standing: rule zero governs all of the above

Where a finding is about **core's** behavior (H3, H10, H12, H13, H14), the
test must run through core's production path — not the adapter's, and not a
hand-built registry. Where it is about what LHC **stores** (H1, H5, H6), it
must read the stored row back. Your rule-zero audit list at the end of the
report must cover both categories.
