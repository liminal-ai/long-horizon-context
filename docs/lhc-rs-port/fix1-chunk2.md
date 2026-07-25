# Chunk 2 fix round 1 — the items that do not depend on Lee's ruling

**Chunk 2 of 3, Phase 3 of 3 — unit ~17 of 18.**

Both verifiers returned CHANGES REQUIRED. Two findings are **escalated to Lee**
and are **not** in this round — do not touch them, and do not work around them:

- **Serving coverage** (`/btw` recap and memory-flush read native history and
  bypass hook 4). Blocked pending a ruling on new touchpoints.
- **Replace-mode accounting** (hook 5 suppresses the only thing that lowers
  the native token count). Blocked pending a design ruling.

`CompactMode::Replace` must be treated as **not reachable** until that ruling
lands — if it is currently reachable by env var alone, gate it behind an
additional explicit "unsafe/experimental" opt-in and say so in your report.

Everything below is independent of both rulings. Same rules as always: work
uncommitted on `lhc`; vendored port read-only; exhaustive matches; C2 (report
out-of-scope findings, don't fix them) — **which was violated this round, see
E0**.

---

## E0 [blocking] Two undeclared core touchpoints

`crates/codegen/xai-grok-shell/src/session/lhc_inference.rs` (new, ~147 lines)
and its `mod lhc_inference;` declaration at `session/mod.rs:331` are **core
changes beyond the two ruled hooks**, unmarked and absent from FORK.md's
"every owned core line" inventory. Both verifiers found this independently;
the sentinel cannot see them because neither is marked.

**My ruling: the placement is fine, the silence is not.** The transport is
genuinely shell-internal (verified), so the implementation has to live there,
and a new file upstream never touches is low sync risk — the only conflicting
line is the `mod` declaration.

Fix: mark the `mod lhc_inference;` line as a hook, **renumber to `n/6`**
across all markers, set `EXPECTED_HOOKS=6`, add both the module line and the
new file to FORK.md's inventory, and correct FORK.md's Patch column — it
currently claims patch `0001` covers hooks 4 and 5, which is false (`0001`
predates them; I regenerate patches after committing).

If you find yourself adding core surface again, **report it** — that is what
C2 requires, and it is the second time this chunk.

## E1 [blocking] `replace_compact` runs twice per logical event, and fail-open is silently reverted

`compaction.rs:1846` (bridge), `:1866` (choke point), `:2012`/`:2015`,
`:1936` + `turn.rs:2062`.

Both helpers call `replace_compact`, which performs *real* compaction work.
On the success path only one runs. On the **failure** path the code is wrong
twice over: the bridge fails open ("native resumes", `:1858`), then
`run_compact_only`'s first statement calls `replace_compact` **again** — a
second full LHC compaction with model inference for the same event. If that
second attempt succeeds, `run_compact_only` returns `Ok(())` and **native
never compacts** — the fail-open decision made three lines earlier is
discarded.

Deleting the `:2054` guard entirely leaves the suite green; neither helper is
called by any test.

Fix: **make the predicates pure.** Resolve one bridge decision per logical
event, memoize it, and execute LHC compaction at exactly one writer choke
point, at most once. A fail-open verdict must be **sticky** for the remainder
of that event. Remove the mutating call from `check_auto_compact_needed`.
Test: a counting double proving exactly one LHC compaction per event in each
shape (success, first-fails-second-succeeds, both-fail), and that a fail-open
verdict actually results in a native compaction.

## E2 [blocking] The disabled path is not behaviorally identical

`turn.rs:2122-2126`, `serving.rs:130`, `lib.rs:109`.

- `native_items.clone()` is unconditional — a deep clone of every
  `ConversationItem` (including base64 image data URLs) on **every turn and
  every tool-loop iteration**, thrown away immediately when LHC is off.
- `apply_serve_decision` emits `warn!` on the Native branch, so **every user
  who has never enabled LHC gets a WARN line every turn.** That is a plain
  behavioral change to the default path.
- `serve_request_context` calls `is_enabled()` (an env read) per turn, while
  MAPPING.md states post-spawn paths use registry presence only.

Chunk 1's capture entry point does this correctly and says so ("Cheap
process-wide gate before any allocation / mutex", `lib.rs:79`). Hook 4
violates the principle Chunk 1 established.

Fix: hoist the cheap gate above the work in `turn.rs` — no `mem::take`, no
clone when inactive; pass by reference or have `ServeDecision::Native` carry
the items back; demote the Native log to `debug!` and only when LHC is active.
Test that the disabled path performs no clone and logs nothing.

## E3 [blocking] Inference adapter violates the brief on five counts

- **Not a dedicated non-main model.** `spawn.rs:450` passes the primary
  session config; `lhc_inference.rs:49` copies its model. The brief required a
  dedicated non-main model, as native compaction uses.
- **Credentials/model snapshotted at spawn and never refreshed**
  (`lhc_inference.rs:44-52`). Native compaction re-resolves every time
  (`compaction.rs:1980` → `:1014` → `:1015`) because tokens expire. Long
  sessions will degrade to permanent 401.
- **No cancellation path** — the trait (`inference.rs:61`) carries no signal,
  and LHC cancellation is explicitly discarded.
- **Operation inputs discarded**: compression/brief callbacks drop all target
  token fields (`inference.rs:166`); tool summarization drops outcome, target,
  class, shape, prompt mode, and facts (`:159`). Every operation gets the same
  hard-coded 2048-token limit (`lhc_inference.rs:91`).
- **Error misclassification**: 401/403 mapped to model refusal; cancellation
  inferred by substring matching (`lhc_inference.rs:123`).

Fix: resolve the host's auxiliary/compaction sampler config (re-resolving
credentials per call), carry full typed operation inputs plus a cancellation
signal through the trait, derive output limits from LHC's target fields, and
classify typed host errors instead of string-matching.

## E4 [blocking] Hook 4 awaits the capture worker with no timeout

`serve_request_context` awaits the worker across a serialized queue that a
compaction can occupy. A slow or wedged LHC operation therefore stalls the
user's turn indefinitely. Fail-open is meaningless if the failure never
arrives.

Fix: bound the wait (a short timeout — serving is on the request path) and
fall back native on expiry, counted and logged once. Test with a deliberately
blocked worker.

## E5 [blocking] Tests that assert constants against themselves

The Chunk 1 lesson, recurring:

- `serving.rs:304` — the **only `prompt_index` test** sets a local integer and
  compares it to the same literal. It cannot fail if substitution destroys
  prompt markers. And per Sol: every translated LHC user message is built with
  `ConversationItem::user` (`serving.rs:50`), which carries **no**
  `prompt_index` — so the hard constraint may already be violated. Establish
  an authoritative LHC-message → native-prompt-index mapping, preserve the
  markers, and test substitution followed by a real rewind and a real fork.
- Two of the five "accounting" tests assert a local constant against itself.
- `chunk2_mock_sampler_registered_at_spawn` does not test registration at
  spawn.
- `chunk2_async_guard_out_of_runtime_watchdog` **cannot fire**: the suspect
  body runs on the test's own thread, so a real hang never reaches `join` and
  the suite hangs anyway. FORK.md claims this closes the Chunk 1 limitation —
  it does not. Either make it genuinely out-of-process/out-of-thread with the
  controlling thread on a wall-clock timeout, or revert FORK.md's claim to
  "still open". **Do not leave the false claim standing.**

## E6 [major] Missing certification

No test invokes `replace_compact` or `shadow_preview_compact`; nothing counts
real operations, covers the failure shapes, compares native vs LHC on a long
session, or exercises threshold/abort/fallback/concurrency. Inference tests
cover only `SmoothPrompt` through a mock — never the shell implementation,
cancellation, timeout, typed failure classes, target limits, or model
selection. Add counting/failing doubles and cover every shape.

## E7 [minor]

- `cargo fmt --check` fails on the LHC crate (`tests/golden_smoke.rs:383,414`).
  Run the exact commands from the verify brief, including `--all-targets`.
- `Replace` mode silently no-ops user-invoked `/compact <context>`, discarding
  the user's instructions (`compaction.rs:604`). At minimum tell the user;
  ideally pass the context through.
- `lhc_inference.rs`'s doc comment describes model-selection logic that does
  not exist.

---

## Report

Position against the full project. For **E0–E7**: fixed / not fixed and why.
Confirm explicitly that you did **not** touch the two escalated items and that
`Replace` is unreachable pending the ruling. Give final counts, the post-fmt
numstat for every core file, and the corrected hook numbering.
