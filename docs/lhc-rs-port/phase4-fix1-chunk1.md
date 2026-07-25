# Phase 4 / Chunk 1 — fix round 1

Resume your Chunk 1 session. Same repo (`/srv/work/codex`, branch `lhc`),
same rules: **do not commit, do not push**; the orchestrator is sole
committer. Position unchanged: **Chunk 1 = unit 20 of 22**, capture only,
Chunks 2–3 remain and are the larger part.

Two independent verifiers audited your work and reproduced defects with
probe code. Their findings below are **reproduced, not speculative** — do not
argue them down; fix them. Where a finding contradicts something in your
report, the finding won on evidence.

Read `/tmp/claude-1000/-srv-work-codex/6ea2a00a-fbf9-40c6-96c8-8e8d737593c4/scratchpad/orch-findings-chunk1.md`
for the orchestrator's own findings (O1–O5) as well.

---

## F1 (BLOCKER) — restart/replay double-records; the module doc is false

`idempotency.rs:14` claims "resume/replay/retry mint identical keys for the
same logical item". The code does the opposite: the occurrence tracker is
seeded to the **high-water mark** of stored keys at open, and `next()`
allocates one **above** it. Reproduced:

```
PROBE restart-replay: before=1 after=2
  key=codex:probe-restart:g0:1aaacafa…:0:user_prompt
  key=codex:probe-restart:g0:1aaacafa…:1:user_prompt
```

One human utterance, two `user_prompt` events after a restart.

You have two genuinely different requirements colliding:
- an item **re-presented** after restart/replay must mint the *same* key
  (dedup is the whole point);
- two **legitimately distinct** occurrences of an identical item must mint
  *different* keys.

High-water seeding satisfies only the second. Resolve this properly: the
discriminator must be something that distinguishes "the host is replaying
history it already gave me" from "the user said the same thing twice". The
host offers real signal here — `ResponseItem` carries `ResponseItemId`
(`id: Option<ResponseItemId>`), and `InitialHistory` replay is a distinct
code path from live recording. **Design it on typed host signal, not on a
counter heuristic**, then make the module doc match the code.

Whatever you choose, both properties above need a test that fails when the
property is broken.

## F2 (BLOCKER) — crash after a *partial* submit double-records on retry

`capture.rs:217-236` × `session.rs:117`. The certification test
`crash_mid_persist_then_retry_records_once` (`tests/certification.rs:365`)
only ever calls `arm_crash_mid_persist(0)` — crash *before* any submit, the
single case that cannot expose the bug. The facility supports `after>0` and
nothing uses it. Reproduced with `after=1` on an `ImageGenerationCall`
(2 events):

```
PROBE crash-partial: total=3
  ToolCall   …:0:tool_call:ig_probe   ← survived the crash
  ToolCall   …:1:tool_call:ig_probe   ← retry re-recorded it
  ToolResult …:1:tool_result:ig_probe
```

Fix the double-record, and **parameterize the crash test over every
injection point** (before, between each event of a multi-event item, after),
not just 0.

## F3 (BLOCKER) — the tripwire is green with a core hook that does not compile

`scripts/check-lhc-hooks.sh` layer 2 builds only `-p codex-lhc-host`, which
does not pull in `codex-core` or `codex-app-server`. A verifier replaced the
hook body at `core/src/session/mod.rs:3286` with
`let _this_does_not_compile: u32 = "lhc";`, left the sentinel in place, and
got `ALL TRIPWIRES GREEN`.

This is the Phase 3 Chunk 2 escalation repeating verbatim, inside the script
written to prevent it. Layer 2 must compile the crates that carry the hooks
(`cargo check -p codex-core -p codex-app-server -p codex-extension-api`, or
the workspace), and the header's "WHAT THIS SCRIPT ACTUALLY RUNS" list must
say so truthfully.

Note when you re-enumerate: `cargo check --all-targets` currently fails on
pre-existing upstream test breakage (`missing field started_at_ms in
ItemCompletedEvent`, from `af7f6f4d34`) — that is upstream's, not ours.
Scope the check so it is green on a clean tree and red on a broken hook.

## F4 (BLOCKER) — the crux requirement has zero production-path coverage

A verifier gutted the production wiring (`session.rs:117` →
`Ok(OccurrenceTracker::new())`, removing "seed from LHC's stored events")
and **the entire suite still passed**: 9/9 certification, 18/18 lib.

Only the pure function `seed_occurrence_from_keys` is tested; nothing tests
that `LhcSession::open` uses its result. And
`idempotency_under_retry_records_once` does not close the gap — its own
comments concede the production restart path allocates `occ=3`, then route
around it by hand-building a `naive` tracker and submitting through a
*separate* `LhcSession`. That test certifies that the vendored port dedups
keys it is handed — a property of LHC, not of your adapter.

Every hard invariant needs a test **through the production path**. After
F1's redesign, re-derive this test so it exercises `LhcSession::open` →
capture → restart → capture.

## F5 (BLOCKER) — a literal no-op test, and a real 80%-loss path behind it

```rust
fn dropped_counter_visible() {
    assert_eq!(0u64, 0);
}
```

`tests/certification.rs:551`. FORK.md law 8. Worse, the invariant it names is
genuinely uncovered: a verifier pushed 5000 persists into the
`CAPTURE_QUEUE_CAP = 1024` queue and measured **3975 items silently
dropped** — `dropped_count()` reported it correctly and no test asserted
anything. Chunk 2's write-back would build on a record that can be 80% lossy
under burst with nothing noticing.

Write the real test. Then decide, and state, whether silent lossy capture is
acceptable at all for a durable record — if the queue fills, the honest
options are backpressure or a loud, surfaced degradation, not a warn line.
Recommend one; do not quietly keep the current behavior.

## F6 (BLOCKER) — replace the content-keyed classifier with typed provenance

`mapping.rs:60-65,593-607`. FORK.md law 6. The prefix table misroutes in both
directions — reproduced against the real markers in `core/src/context/*.rs`:

```
runtime_note  UserInstructions            ← the only one that matches
user_prompt   RolloutBudgetContext        ┐
user_prompt   ModelSwitchInstructions     │ 10 of 11 host-generated
user_prompt   SubagentNotification        │ fragments recorded as
user_prompt   UserShellCommand            │ human input
user_prompt   TurnAborted                 │
user_prompt   CurrentTimeReminder         ┘
runtime_note  REAL prompt: "[runtime note] is a phrase I typed"
runtime_note  REAL prompt: "<user_instructions> what does this tag mean?"
```

`<turn_aborted>` and the current-time reminder fire routinely, so
`user_prompt` — LHC's human-intent signal, load-bearing for banded
compaction in Chunk 2 — is systematically poisoned.

**A typed discriminator does exist**, contrary to one verifier's read. It is
at the recording call sites, not in the item:

- `record_user_prompt_and_emit_turn_item` (`core/src/session/mod.rs:3942`)
  takes `&[UserInput]` — the dedicated real-human-input path;
- `:3764` records context items from
  `build_initial_context_with_world_state` — host scaffolding;
- `record_response_item_and_emit_turn_item` (`:3927`) — model output;
- `record_inter_agent_communication` (`:3087`) — inter-agent traffic.

Thread a typed `RawItemProvenance` enum through `RawItemInput`, set at each
call site, and **delete `BOOTSTRAP_PREFIXES` and `runtime_note_text`
entirely**. Classification becomes a `match` on a host-supplied enum with no
wildcard arm.

This widens the `core/src/session/mod.rs` footprint (the hook moves from one
site to the recording functions, and `send_raw_response_items` /
`record_conversation_items` gain a parameter). That is authorized — it stays
inside the enumerated touchpoint and law 6 is binding — but it must be
sentinel-marked, inventoried, and patched like every other hook.

## F7 (MAJOR) — `FunctionCall.arguments` is not byte-exact, and duplicate keys are lost

`mapping.rs:666-680`. Reproduced:

```
in={"n":1e3}               out={"n":1e+3}        byte-exact=false
in={ "a" : 1 ,  "b" : 2 }  out={"a":1,"b":2}     byte-exact=false
in={"k":1,"k":2}           out={"k":2}           byte-exact=false  ← data loss
in=42                      out={"raw":42}        (parsed, not the bytes)
```

Two claims in your report fail on evidence: the digest is an irreversible
SHA-256, so "the raw string is in the item digest" is not preservation; and
`{"raw":…}` inserts the *parsed* `Value` for parseable non-objects
(`mapping.rs:669`), so bytes survive only in the `Err` arm.

`MessageEventInput.extra` is an available `Map` and is empty on every event.
Put the verbatim `arguments` string there. Keep the parsed object for LHC's
schema; carry the original bytes alongside, and test the four cases above.

## F8 (MAJOR) — inline image/audio truncated to 128 chars

`mapping.rs:57,551-566,642-652`. A 4022-byte data URL → 146 bytes captured.
Audio truncates with **no** marker, so the loss is undetectable downstream.
The brief required: capture the bytes as-is and document the ceiling — do not
summarize. Either carry the payload (`extra` again) or, if you judge full
data URLs genuinely must not enter the LHC record, say so explicitly with a
reason, make the truncation loud and marked in every case, and record it as a
scheduled-verification item in FORK.md. Do not leave silent asymmetric loss.

## F9 (MAJOR) — the rusqlite bump has no provenance; a fresh clone will not build

Your bump is **correct and forced** — independently confirmed: rusqlite 0.37
→ `libsqlite3-sys ^0.35`, 0.39 → `^0.37`; codex-rs already pins
`libsqlite3-sys 0.37` (`codex-rs/Cargo.toml:350`, deliberately, for a WAL
corruption fix); two `libsqlite3-sys` majors both carrying `links = "sqlite3"`
is a hard cargo error, and 0.39 is the lowest rusqlite that reaches 0.37. The
orchestrator ran the **full port gate** on the bumped tree: `GATE PASS`,
classified=496 passed=481 ignored=15 wrong=0 suspicious=0 — arithmetic
unchanged.

The defect is provenance: the change exists **only** as an uncommitted
submodule working-tree edit, in no commit and in no patch. FORK.md's own
history-reset drill (fresh clone → restore fork files → `git apply
patches/lhc/*.patch` → tripwires green) yields a workspace that does not
build, because submodule init restores rusqlite 0.37.

**Leave this to the orchestrator** — it requires a commit in the port repo
and a submodule pin bump, which is the orchestrator's to make. Your only
action: **correct the FORK.md wording**. "Pure packaging; no LHC semantics
change" overstates it — the bundled SQLite version does change
(libsqlite3-sys 0.35 → 0.37). Say what is established: the port gate passes
at 0.39 with unchanged arithmetic, and the bundled SQLite moves onto the same
build codex-rs pins deliberately.

## F10 (MINOR, but fix all of these)

- **`Cargo.lock` (131 changed lines)** is an upstream-tracked core file with
  no inventory row and no possible sentinel. Add an explicit FORK.md
  inventory row stating it is regenerated, not hand-edited.
- **`raw_item.rs:13` is `/// # LHC-HOOK`** — a markdown heading in a doc
  comment, counted toward `EXPECTED_HOOKS=19` by accident. Rename the heading
  and fix the count.
- **Hook numbering is `n/8`** against 6 touchpoints and 19 markers, while
  FORK.md says 19. Pick one denominator and make code, script, and FORK.md
  agree.
- **Layer 3 is a file count**, not the "capture→rebuild diff" that FORK.md's
  scheduled-verification table now records as armed. Either arm the real
  thing or correct both the header and the FORK.md row to say exactly what
  is armed.
- **Mapping-table claims the code does not support**: `ContextCompaction`
  "else empty note" (code returns `Vec::new()` — not captured);
  `Message` assistant "output_text joined" (code joins `InputText` too);
  `AgentMessage`/`AdditionalTools` "structured … preserved" (both flatten to
  a prose string, brushing law 5 — put the structure in `extra`).
- **`encode_thread_id_for_path`** maps every non-alphanumeric to `_`, so
  `a:b` and `a_b` collide into one thread SQLite. Low risk today; free to fix.
- **`capture_disabled` after 3 failures** (`session.rs:160`) makes a thread
  go permanently dark with no counter and no test. `poison()` exists to make
  this testable and nothing calls it. Surface a terminal state and test it.
- **Flag-off is not literally inert**: `install()` is called unconditionally
  and the contributors are registered, allocating a `Box::pin` per item batch
  even with the flag off. Either register nothing when the flag is off, or
  correct the brief's "no LHC code paths execute" claim to what is true.

---

## Re-verification standard

Every fix above lands with a test that **fails when the fix is reverted**.
For F1–F6 specifically, report the actual failure output — break it, run it,
paste it, restore it. A verifier gutted production code and watched 27 tests
pass; that is the bar you are being measured against now.

Re-run `./scripts/check-lhc-hooks.sh` (after F3 makes it real) and paste the
output. Update the FORK.md inventory, `EXPECTED_HOOKS`, and `patches/lhc/`
in lockstep, as before.

## Report

Per finding: what changed, `file:line`, the test that now guards it, and its
break-it output. Call out anything you disagree with and why — with evidence,
not argument. State the 22-unit position frame and what remains.

---

# Second verifier — additional findings (independent lane, same tree)

The second verifier reproduced F1, F2, F4, F5, F6, F7 independently, and
added the following. Where the two lanes disagreed, the orchestrator's
adjudication is stated — those rulings are final for this round.

## F11 (BLOCKER, supersedes part of F3) — capture can be entirely disconnected with every gate green

Worse than F3. A verifier **deleted the whole contributor invocation** from
`core/src/session/mod.rs:3285`, keeping only the comments: **all 9
certification tests passed and the sentinel count stayed 19/19.**

So the seam that makes this chunk *capture anything at all* is unproven by
every gate that claims to prove it. The certification suite exercises the
adapter in isolation and never once drives a real `Session` through
`record_conversation_items` to observe an LHC event come out the far end.
Sentinels prove a comment exists; they cannot prove a call is wired.

Required: an **end-to-end test through the real host seam** — construct a
session using core's own test helpers, record items through
`record_conversation_items`, assert the LHC record contains them. It must
fail when the hook body is deleted. This is the single most important test in
the chunk; everything else certifies a library nobody proved is called.

Adjudication on hook-count (the lanes disagreed — one called 18 of 19 markers
legitimate, the other called 12 inflated): **both miss the operative point.**
Whether a field declaration deserves a sentinel is cosmetic. What matters is
that a marker survives deletion of the code it marks, so `EXPECTED_HOOKS` is
not a wiring gate and never was. Fix the numbering per F10, but do not treat
sentinel arithmetic as coverage — F11's test is the coverage.

## F12 (BLOCKER) — the tripwire reports a certified pin while running modified source

`scripts/check-lhc-hooks.sh:76` prints the submodule commit but never checks
whether the submodule working tree is **dirty**. Throughout this entire round
it printed `vendor pin: 5399c41` and `ALL TRIPWIRES GREEN` while compiling a
locally modified, uncertified port.

Add a hard check: dirty submodule ⇒ tripwire fails. The pin line must report
what is actually being built, not what is checked out.

## F13 (MAJOR) — Bazel lockfile not updated; upstream procedure violated

`AGENTS.md:37-38`: "If you change Rust dependencies (`Cargo.toml` or
`Cargo.lock`), run `just bazel-lock-update` from the repo root to refresh
`MODULE.bazel.lock`, and include that lockfile update in the same change."

`codex-rs/Cargo.toml` and `Cargo.lock` both changed; `MODULE.bazel.lock` is
untouched (verified). Run it and include the result. This is upstream's rule,
and CI enforces it — a fork that breaks it makes every future sync harder.

## F14 (MAJOR) — no test for item ordering across resume

The brief names ordering across resume a **hard constraint**, and FORK.md law
3 requires hard constraints to have tests that can fail. Searching the adapter
suite found no resume-order assertion at all. Add one, through the production
path (it composes naturally with F11's end-to-end test).

## F15 (MAJOR) — `model_change` / `thinking_level_change` are never emitted

No mapping path produces either kind, though both are in LHC's closed
`EventKind` vocabulary and the Phase 4 brief lists "model/thinking changes"
as part of full-fidelity capture. A mid-thread model or reasoning-level
change is simply absent from the durable record.

Grok Build handles this with a dedicated tee (`map_model_change` in its
`mapping.rs`, driven by a model-switch hook) — but do **not** copy its hook
site blindly; find the Codex seam. `TurnStartInput` carries per-turn context
and `ConfigContributor::on_config_changed` exists. If no seam carries it
without a new core touchpoint beyond those enumerated, **stop and report** —
do not add an unenumerated hook to reach it.

## F16 (MAJOR) — the raw-item hook awaits contributors with no timeout or unwind containment

`core/src/session/mod.rs:3287` awaits arbitrary contributor futures inline.
Both lanes agree there is **no deadlock** (the `state` lock is released in a
scoped block before the call — this was checked and disposed of), but a slow
contributor delays conversation recording and a panicking one unwinds through
it. Capture must not be able to take down or stall the session path: contain
the future (catch-unwind at the adapter boundary and/or a bounded timeout),
and test that a panicking contributor leaves recording intact.

## F17 (MAJOR) — enabling capture blocks session construction

`install.rs:91` / `session.rs`: `on_thread_start` awaits `create_dir_all` +
SQLite open/resolve + a full `list_events` scan, so a slow or hung database
delays the user's session before `Session` exists. This contradicts "capture
never blocks or slows the session path" (brief §B). Open lazily or off the
critical path; keep the seeding correctness F1 requires.

---

## Orchestrator rulings this round (do not relitigate)

- **rusqlite is settled.** The bump is forced and now has provenance: it is
  committed as `3663839` on branch `lhc-rs-port-codex-pin` off the pinned
  `5399c41`, pushed to the port origin, the submodule pin is bumped and
  `.gitmodules` retargeted. One lane asked for "a certified port commit and
  new pin" — that is exactly what was done, and the **full port gate** was
  re-run on that tree: `GATE PASS`, classified=496 passed=481 ignored=15
  wrong=0 suspicious=0. Do not re-edit the submodule. Your only rusqlite
  action remains F9's FORK.md wording, which must now also record the
  bundled SQLite move (3.50.2 → 3.51.3) and the new pin (5399c41 → 3663839).
- **The classifier fix is determined, not open.** One lane recommended
  escalating F6 to Lee believing no typed discriminator exists. One does —
  `record_user_prompt_and_emit_turn_item` (`core/src/session/mod.rs:3942`)
  takes `&[UserInput]` and is the dedicated human-input path, distinct from
  the context-item (`:3764`), model-output (`:3927`), and inter-agent
  (`:3087`) sites. Implement typed provenance per F6.
- **Priority order**, if you cannot finish everything: F11 first (nothing
  else means anything if capture isn't wired), then F1/F2/F4 (the
  idempotency family), then F6, then F3/F12, then the rest. Report honestly
  on anything you did not reach rather than thinning the tests to fit.
