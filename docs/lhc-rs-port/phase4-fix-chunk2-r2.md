# Phase 4 / Chunk 2 — fix round 2

Resume the same session. **Do not commit, do not push.**
Position: **unit 21 of 22.** Chunk 3 (live cert) follows.

Round 1 landed. Both the orchestrator and the verifier lanes confirmed F2,
F3, F5 behave correctly in the live tree, and the fail-open-to-native path
was proven to **terminate** (three production probes; the stack overflow I
saw under mutation was a test artefact, not a production hang).

Three blockers remain (G1-G3), all narrow and local. Do not restructure.

Note on G1's severity: the lanes disagreed. One filed it BLOCKING with a
failing probe; the other rated the same code non-blocking, reasoning that
LHC's verbatim tail turns are in the archive anyway. I am ruling it blocking:
the probe demonstrates a real omission, the principle (identity over content)
is the one this chunk has now violated twice in both directions, and the fix
is a reorder. Cheap to fix, silent when wrong.

---

## G1 — BLOCKING. Coverage excludes by content digest *before* checking
identity, so a genuine native turn can be silently dropped

`compact_bridge.rs:328-341`, in `host_items_missing_from_archive`:

```rust
let content_d = content_identity_digest(item);
if derived.contains(&content_d) {   // <-- runs FIRST
    continue;
}
if let Some(id) = item_stable_id(item) {
    if archive_ids.contains(&id) { continue; }
    missing.push(item.clone());
```

A resumed/forked native item with a **new stable id** but text equal to some
previously-served body item matches `derived` and is skipped — so it is never
reported missing, never imported, and LHC compacts an archive that is missing
a real user turn. Verifier probe:

```
F1 stable-ID/content collision:
left:  []
right: [Message { id: "new-native-stable-id", text: "turn one about cats" }]
FAILED
```

This is the F1 fix reintroducing the very class it was meant to remove:
a content-keyed decision overriding an identity-keyed one (FORK.md law 6).
Round 1 fixed the direction that corrupted the archive; this is the direction
that loses history.

**Ruling — identity wins over content, always.**

- If an item has a stable id: its presence in the archive is decided **only**
  by that id. Never skip it because its text matches a derived digest.
- The derived-digest exclusion applies **only** to items with no stable id
  (the anon multiset path), where content is the only signal available.
- If that leaves an anon item ambiguous, prefer **refuse** over skip. Refusing
  falls open to the native ladder; skipping loses a turn.

**Test:** a resumed item with a fresh stable id whose text equals a
previously-served body item must be reported missing. Must fail if the
ordering is reverted.

---

## G2 — BLOCKING. Patch 0007 is stale — it reconstructs pre-fix behaviour

Verified independently by the orchestrator:

```
grep -c NoReduction patches/lhc/0007-lhc-compact-arm.patch  -> 0
grep -c NoReduction codex-rs/core/src/compact_lhc.rs        -> 1
```

The patch applies cleanly to HEAD, so nothing fails loudly — but the tree it
produces has **no F3 guard**, still **awaits `join.join()` after timeout**
(no F4), and lacks the re-cut F2/F3/R5 tests. Anyone running the history
reset drill silently gets pre-fix code. Six other patched files matched the
working tree exactly; the two that differ are `core/src/compact_lhc.rs` and
`core/src/compact_lhc_tests.rs`.

That defeats acceptance criterion 8 (sentinels / inventory / patches in
lockstep) and it defeats the drill the patch series exists for.

**Ruling:** regenerate patch 0007 from the current tree. Then **prove** it,
do not assert it: apply the series to a clean checkout and show every file
byte-identical to the working tree. Paste the comparison.

**And fix the reason this was missable:** the tripwire's patch layer today
only checks that patches *apply*. It must also check they **reproduce**.
Add a layer that applies the series to a scratch checkout and diffs the
result against the working tree, failing on any difference. A patch series
that applies cleanly but reconstructs different code is precisely the
green-gate-over-broken-state failure the tripwire exists to prevent.

---

## G3 — BLOCKING. The derived set is guarded by a best-effort write, so a
lost marker commit silently restores the archive-corruption defect

`compact_lhc.rs:191-194`. `derived_content_digests` is the only thing keeping
the served body out of the archive — and it lives **solely on the committed
marker**. But the commit is explicitly best-effort:

```rust
if let Err(err) = commit_marker_on_thread(...).await {
    warn!(%err, "LHC compact marker commit failed after write-back");
    // Body is already installed; surface but do not roll back host history.
}
```

The arm still returns `Installed`. The host now holds the LHC body while the
archive has no record that it is derived. Body items carry `id: None` from
`llm_request_context_to_response_items`, so on the next compact they fall to
the anon-digest path, miss, and are imported.

Verifier evidence, two identical 300-event archives run side by side:

```
CASE A (marker committed):     events 301 -> 301   derived_source_events=0
CASE B (marker commit failed): events 300 -> 360   derived_source_events=1
   tail: user_prompt|user turn 150: lorem ipsum ...
```

60 body items re-ingested, including LHC's own `[context · smooth]` entry
written back as a source turn — exactly the defect F1 closed. Reachable on a
30s timeout, thread-spawn failure, or `LhcSession` open/submit failure under
SQLite contention with the capture worker.

**Ruling:** a correctness invariant may not depend on a best-effort write.
Pick one, and I prefer the first:

1. **Persist the derived set with the write-back**, in the same operation
   that installs the body, so it cannot be lost independently; or
2. treat a failed marker commit as a **failed compact** — fail open to the
   native ladder rather than returning `Installed`.

Do not simply retry harder. The invariant must hold when the write fails.

**Test:** force the marker commit to fail, compact twice, assert the archive
gains no derived source events. Must fail if the guarantee is reverted.

---

## G4 — Non-blocking, do them while you are here

- `compact_lhc_tests.rs:462` comment still claims hook removal reaches a 401;
  that is no longer what happens.
- `compact_lhc_tests.rs:508` constructs a default OpenAI provider (base URL
  `api.openai.com`). No test should reference a live endpoint even if it
  never dials it.
- `derived_digests_from_archive` grows without bound: every marker's full
  digest list is parsed and unioned on every compact. Bound it (most recent
  marker, or prune on commit).
- `three_compacts_do_not_reingest_body` assigns synthetic ids to body items,
  but production leaves them `None` — so the test exercises the id path while
  production uses the anon path. Make the test use the production shape.

---

## Standing bar

- No `include_str!`/grep-style tests. No test that cannot fail.
- Every invariant proven by mutation: break it, paste the failure, restore,
  re-pass. **Paste real output.**
- Round-trip through a real `LhcSession`.
- Do not commit, do not push.

## Out of scope

Module length, change-set size, documentation polish, naming, inventory
prose. Fix FORK.md only where behaviour changed and the text is now false.
