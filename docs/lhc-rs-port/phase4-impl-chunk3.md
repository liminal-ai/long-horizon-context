# Phase 4 / Chunk 3 — live certification and sync rehearsal (unit 22 of 22)

You are the Chunk 3 implementor. **Do not commit, do not push.**

Working tree: `/srv/work/codex`. Read `FORK.md` first — its laws bind.
Chunk 2 is committed at `3aa3a44d22`; `git log` it for what landed.

This is the **last unit**. Chunk 2 (the compact bridge) is accepted:
body from `lhc.compact()`, identity-based derived provenance, durable
write-back, real `ModelClient` inference on pinned `gpt-5.6-luna`, and a
13-layer tripwire including `patch-repro` and `upstream-schema`.

Chunk 3 is **certification, not construction.** If you find yourself
redesigning, stop and report instead.

Brief §"Chunk 3" defines three parts. Lee's sign-off is him using
LHC-backed Codex for real work, so the deliverable is evidence he can trust,
not more code.

---

## Carried gaps from Chunk 2 — settle these here

`codex-rs/lhc/CHUNK2-ROUNDLOG.md` §"Named gaps" lists four. Two are yours:

- **Gap 1 — M1 core-level measurement.** The idle pump is proven in the host
  crate; a core-level end-to-end measurement failed unexplained and the test
  was deleted rather than left meaningless. `remaining` grew under the core
  pump and fell under the host pump; nobody accounted for it. Settle it or
  record precisely why it cannot be settled.
- **Gap 2 — real per-call latency is unmeasured.** All timeout arithmetic
  (297 calls x assumed 300ms–1s) is arithmetic, not measurement. C1 must
  produce a real number; it determines whether the 120s bound and the idle
  pump actually hold in practice. This is the single most important number
  in Chunk 3.

## SEQUENCING — read before you start

Chunk 3 splits into work that costs nothing and work that spends Lee's
ChatGPT plan quota. **Do the free work first, and do not spend without a
ruling.**

**Phase A (now, no quota):** C2 in full (sync drill + patch series drill),
Gap 1 (the M1 core-level discrepancy), and every part of C1 that can be
driven with test callbacks — resume, fork, abort/cancel, and the *shape* of
the KV/prefix-cache question.

**Phase B (blocked on Lee's budget ruling):** every run that calls
`gpt-5.6-luna` for real — the ≥3 real compacts, the auth-lane confirmation
in a live session, and the real per-call latency measurement (Gap 2).

At the end of Phase A, produce a **costed plan** for Phase B: for each live
run, the history size, turn count, expected model calls (~3/turn), and a
token estimate with its arithmetic shown. That plan is what I take to Lee.

**Do not run Phase B.** Stop and report when Phase A is done.

The last authorised live run overran its estimate 12x because it was bounded
by turn count instead of input size. Bound by *input tokens per call x
calls*, and say so.

## C1 — Long real sessions on the fork

Drive the fork end-to-end with the feature **on**, real tool use, and real
compacts. Not fixtures.

Required paths, each exercised and reported:

1. **Multiple real compacts in one session** (≥3), with real derivation
   (`gpt-5.6-luna`). Report per-compact: source events, body items, tokens
   before/after, band composition.
2. **Resume** mid-session after a compact — history reconstructs, no
   re-ingest, derived provenance survives (this is I2's durable path in
   anger).
3. **Fork** (`SpawnAgentForkMode::FullHistory`) after a compact — the census
   flagged this as the highest-risk consumer. Confirm the child inherits a
   coherent body.
4. **Abort / cancel mid-compact** — the turn survives, no partial install,
   no marker.
5. **Auth-lane behaviour under the ruled config** — confirm derivation rides
   `gpt-5.6-luna` and **not** the user's turn model, in a real session.

**KV / prefix-cache impact — measure it.** The brief asks for this
explicitly and nobody has. A compact rewrites history, so the prefix cache is
invalidated; quantify the cost (cached vs uncached input tokens on the turns
after a compact). Report numbers, not adjectives.

**Cost discipline — binding.** Lee's authorised eval overran 12x because
nobody bounded *input size*. Before any live run: estimate total tokens from
history size x turns, state it, and keep each run bounded. Report actual
usage per run and a chunk total. If a planned run would exceed ~50k tokens,
**stop and ask** rather than spend.

---

## C2 — Upstream sync drill, for real

Run one full upstream sync through the FORK.md drill with hooks live.
`session/mod.rs` is the top-ranked risk (70 commits/30d), so expect real
conflicts — that is the point of the exercise.

- Fetch upstream, attempt the sync, resolve conflicts, and **record what
  broke and how it was resolved** in FORK.md.
- Re-run the tripwire after. All 13 layers.
- If sentinels moved or a hook site vanished, that is an **escalation
  discovery** — report it, do not route around it.

Then rehearse the **history-reset recovery drill**: apply
`patches/lhc/0001..0007` to a clean checkout and prove byte-identity with
the working tree. `patch-repro` already does this for 0007; do the whole
series.

---

## C3 — The certification record

Produce a single document a reader can trust without rerunning anything:
`codex-rs/lhc/CHUNK3-CERTIFICATION.md`.

- What was exercised, with real numbers (tokens, events, items, timings).
- What was **not** exercised, named plainly. An honest gap list is worth
  more than a claim of completeness — and every previous round of this
  project that concealed a gap cost a round to undo.
- The KV/prefix-cache measurement.
- Known ceilings (encrypted reasoning opacity, fork-off-old-compact-point
  cap, ModelOutput-vs-HostContext tag fidelity).
- A plain statement of whether **you** would use this for real work, and
  what you would watch.

---

## Standing bar

- Tests round-trip the production path. No `include_str!`. No test that
  cannot fail.
- Mutation-prove any new invariant: break it, paste the failure, restore.
- **Do not run workspace-level `cargo fmt`** — it dirties the vendored
  submodule pin. Use `-p codex-lhc-host`.
- Do not commit, do not push.

## Escalate rather than improvise

- Band-shape behaviour turns out negative in a real session.
- The sync drill reveals an upstream change that removes a seam.
- Any live run would exceed the cost bound above.

These are rulings I owe Lee, not fixes for you to invent.
