# Chunk 3A is accepted — begin Chunk 3B

You were right to stop. The gate is now satisfied, explicitly:

**Chunk 3A is ACCEPTED, committed as `5b19be8`, and pushed**, with the patch
series regenerated across all four fork commits at `0e89134`.

Evidence:

- **Both verifier lanes returned PASS**, in separate trees, with no blocking and
  no carryable findings.
- Each independently re-demonstrated that the round-4 vacuity gap is closed by
  reverting the **production** branch of `refresh_binding` and watching
  `ab1_refresh_snapshot_atomic_keeps_mid_session_on` fail with `events=1`.
- The encapsulation was attacked three ways and held: direct construction
  (`E0451`), post-hoc desync of a legitimate snapshot (`E0616`), and reaching
  for `from_parts_for_test` from a production build (`E0599`, with identical
  source compiling under `test-util`).
- Gates at acceptance: 151 lib, 85 certification, 5 goldens, both fmt, clippy
  `--all-targets` clean, tripwire green, **hooks 6/6 — no seventh**.
- `patches/` regeneration list verified equal to
  `git diff --name-only origin/main -- crates/codegen/ Cargo.toml` (fourteen
  paths), and the recovery drill rehearsed: `git am --3way` onto a fresh clone
  applies clean.

**Now run the harness track: B1–B8 in `impl-chunk3b.md`**, including the B8.4
carryables that Chunk 3A deferred here with named checkpoints.

Two reminders from that brief that matter most, because they are the ones that
would quietly produce a meaningless result:

- **B8.1 — never read `informational_divergences == 0` as evidence without
  first asserting `turns_served_and_compared > 0`.** A hook-2/hook-3 session-id
  mismatch yields zero compared turns, which reads identically to a clean run.
  Always report both numbers, plus the fallback ratio.
- **B8.3 — G2 re-verifies instrument CALIBRATION, not just fixtures.** If the
  live Replace body differs from the renderer-faithful fixtures, regenerating
  the fixtures is *not* sufficient — the instrument's own correctness is what is
  in question.

End with the explicit list of what the harness **cannot** prove. That list
becomes Lee's live runbook, so it is a deliverable, not a caveat — be concrete
about what needs a real session, real credentials, or real network, and why.

If any item needs a seventh hook or a vendored-port change, **stop and report**
rather than widening scope.
