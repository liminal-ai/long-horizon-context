# Phase 4 / Chunk 2 — fix round 3

Resume the same session. **Do not commit, do not push.**
Position: **unit 21 of 22.**

One blocker, and it is my fault, not yours. My G1 ruling ("identity wins over
content, always") was right in principle and wrong in a detail I did not
check: **the installed body is assigned stable ids at write-back**, so
identity alone cannot distinguish LHC-derived items from native ones.

---

## H1 — BLOCKING. The derived set is content-keyed, but the body gets ids,
so the stable-id branch imports the body anyway

Verified by the orchestrator at the line level:

```
compact_lhc.rs:172   slot.mark_derived_digests(...)      <- content digests
compact_lhc.rs:173   sess.replace_compacted_history(...) <- ASSIGNS IDS
session/mod.rs:3221  Self::assign_missing_response_item_ids(...)
```

`replace_compacted_history` calls `assign_missing_response_item_ids`. So
after write-back the body items **have** stable ids. On the next compact they
take G1's stable-id branch, which is identity-only and never consults the
derived set — they are not in the archive, so they are reported missing and
imported. The archive-corruption defect returns in production, through the
exact path G1/G3 were meant to close.

The premise in round 2's report — "production shape: body keeps `id: None`" —
is false. `three_compacts_do_not_reingest_body` passes because it constructs
body items directly instead of round-tripping through
`replace_compacted_history`. That is the "test does not use the production
shape" defect, and this time it hid a live blocker.

### Orchestrator's direct measurement — this is not a theory

The two lanes contradicted each other (one filed this BLOCKING; the other
reported "mapped body items are `id: None`, confirmed by the test's own
assertion" and ran 12 clean compacts). I settled it by driving
`try_run_lhc_compact_arm` against a real `Session` twice and measuring:

```
PROBE attempt1 = Installed
PROBE after write-back: items=30 with_stable_id=30
PROBE attempt2 = NoReduction: body_tokens=28465 host_tokens=27493 items_body=28
PROBE archive events: before=160 mid=161 after=191
```

**All 30 installed body items carry stable ids.** The archive grew 161 -> 191
on the second compact: the 30 body items, re-ingested as source events. The
`id: None` premise is false on the production path.

Note the second line too: the re-ingestion happened even though attempt 2
then returned `NoReduction` and failed open. The import occurs inside
`produce` (coverage gap -> import) *before* the reduction check, so a compact
that ultimately declines to install still corrupts the archive. Whatever you
do for the ruling below must hold on the fail-open path as well.

**Ruling — derived provenance must be identity-based, not content-based.**

1. After `replace_compacted_history` returns, read back the installed history
   and record the **assigned ids** of the body items as the derived set
   (ids, not digests).
2. The stable-id branch consults that derived-id set **first**: an id known
   to be derived is never a coverage candidate and never an import candidate.
   This does not violate G1 — it is still identity, just identity with
   provenance. Content matching stays confined to the anon path.
3. Keep the content-digest set as a secondary guard for anon items.

Sequencing matters: ids do not exist until after the call, so the recording
must happen after write-back, and a failure to record must fail the compact
(G3's rule) rather than proceed.

**Test — must round-trip through the real production path:** drive
`try_run_lhc_compact_arm` against a real `Session` three times; assert the
archive gains no derived source events. This must be the *production* path,
not hand-built items. It must fail if the derived-id check is removed.

Then re-check `three_compacts_do_not_reingest_body`: rebuild it so the body
goes through `replace_compacted_history` and carries assigned ids. If it
cannot fail under the mutation "remove the derived-id check", it is not
doing its job.

---

## H2 — Cancellation between marking and install

`compact_lhc.rs:172-173`. Marking happens before the install, so a
cancellation or crash in between leaves the slot claiming items are derived
that were never installed. Narrow, but the fix in H1 changes this ordering
anyway: record after write-back and this window closes. Confirm it does.

---

## H3 — Session digest set is uncapped

`install.rs:104` accumulates session digests with no cap, while
`DERIVED_MARKER_CAP = 8` bounds only the archive union. Bound both, and
**log what is dropped** — a silent cap reads as "covered everything".

---

## H4 — Historic forks and the cap

The cap is safe on a linear history because each new marker re-fingerprints
the whole served body, refreshing still-relevant digests. That reasoning does
**not** hold for a fork off an older point. Either bound the cap by something
fork-safe, or document the limit honestly in FORK.md as a named checkpoint.
Do not leave the reasoning implicit.

---

## Standing bar

- **Tests must round-trip the production path.** This round exists because a
  test asserted a shape production does not produce. A hand-built fixture
  that bypasses `replace_compacted_history` does not discharge an invariant
  about what happens after `replace_compacted_history`.
- Every invariant proven by mutation: break it, paste the failure, restore,
  re-pass. Paste real output.
- No test that cannot fail.
- Do not commit, do not push.

## Out of scope

Everything else. G2 is resolved, the patch-repro layer works, and the rest of
G4 is done. Do not restructure.
