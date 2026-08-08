# Chunk 3B — drain architecture repair (Lee's ruling, 2026-07-26)

**Chunk 3 of 3, Phase 3 of 4 — unit 19 of ~22.**

**Stop treating the drain as something the host drives. It isn't.** Rounds 5 and 6
built a host-driven drain and it is architecturally inverted. This supersedes N1,
Q1, Q2 and R3. Read `docs/onboard/01-core-concepts.md`,
`02-domain-design.md` and `04-host-pi-lhc.md` in the port repo before touching
code — this brief is not a substitute for them.

## Why the previous design was wrong

`02-domain-design.md:340` is decisive:

> *"When a band entry depends on a derivation that is not ready, compact does not
> stop. It walks a fallback ladder: the smooth band tries `turn_rendering`, then
> `detailed_turn_compression` (marked degraded), then a deterministic excerpt of
> the turn's messages, then a gap… all degraded entries and gaps are recorded in
> the compact receipt and the stored view metadata."*

Compact **never waits**, by design. Nothing is lost by not waiting: the canonical
event log holds everything and bands are derived *views* over it, so when
background drain finishes a derivation later the stored form upgrades and the next
compact picks it up. Waiting converts "temporarily less compressed" into a
user-visible stall and buys nothing.

Two things this reframes:

- The `[degraded: smooth-from-excerpt]` band we saw in G2 was **the fallback
  ladder working correctly**, not an artifact to be engineered away.
- The ~400 s compact we measured *is the defect itself* — all derivation cost
  billed at compact time, which is exactly what makes first compact on a large
  thread miss its window and fail open to native, on the threads LHC exists for.

## The repair

### 1. Background mode

`session.rs:185`: `mode: SdkMode::Manual` → `SdkMode::Background`.

The machinery is already built and certified in the port — `sdk.rs:1244-1266`
wires the post-commit poke into the scheduler's own run-loop and installs
`set_scheduler_poke`, with first-touch catch-up absorbing a pre-existing thread's
backlog at open. **No host-side plumbing is needed** for the poke; do not add
any.

### 2. Delete the hand-rolled drivers

- `DERIVATION_DRAIN_BEFORE_COMPACT` and `drain_derivations_before_compact`
- the drain-outcome registry's **wait states** — `CompactDrainOutcome::TimedOutFailOpen`
  and the partial-material fail-open path, plus their status surfacing
- the `select!` in `compact` that races cancel against a drain budget

Compact becomes a selection walk with the fallback ladder, **immediately and
unconditionally**. There is no time budget in the compact path of any correct LHC
host.

### 3. Restore the one host-side drain call I had you delete

Round 5's N2 removed `work.drain` from `LhcSession::close`. **That was wrong** —
the ruling keeps exactly one host-side drain-related call: the **capped
`drainSettled` at shutdown**. Restore it, capped.

This also resolves N2 honestly: with Background mode, `/lhc off` is no longer
starting a six-minute drain, because derivations have been draining continuously
all along. Re-check the `/lhc off` status text against the new reality rather
than keeping language written for the old one.

### 4. Re-point the abort tests — the invariant changed

**Background drain continuing after a turn abort is correct behaviour, not a
leak.** The invariant is: **no compact INSTALLS after abort.**

So:

- **R3's `TokenWatchSampler` / `saw_cancel` assertion is now testing the wrong
  property.** Call-cessation is not the invariant. Remove it along with the
  cancel registry, or re-point it.
- **Q1's `ops_after=1` assertion is likewise wrong** — ops continuing is fine.
- **R1 survives and matters more.** The port's `CompactAbortSignal` checked at
  `thread_view/mod.rs:1166`, immediately before the snapshot write, is exactly
  the mechanism that enforces "no install after abort". Keep it wired to the
  turn-abort token, keep the live-read contract, and keep its break-watch-restore
  evidence.

Point every abort test at: after abort, **no compact snapshot is installed and
native history is unchanged** — and let derivation work continue.

### 5. Do not change what is derived

Both bridges run the port's default derivation profile. Volume was never the
defect; timing was. Leave the profile, the 1,000-token tool-result threshold, and
the chunk policy alone. The scoped inference ruling (PromptSmoothing real
inference on `grok-4.5` at low thinking; ToolResultSummary truncate-fallback by
port design) is unchanged.

### 6. Certification evidence — t3code-shaped

The old numbers measured the defect. Replace them with:

- **ready-vs-total derivations at the moment the compact threshold trips** —
  a healthy system shows ready ≈ total
- **compact wall-time in fractions of a second** (reference: t3code live, 97
  summaries pre-built, 0.4 s compact) — not 400 s
- the queue observed **settling between turns**
- **first-touch catch-up** absorbing a pre-existing thread's backlog at open

Re-run every existing suite after the change. Expect the G2 numbers to move
substantially; report the new ones plainly rather than reconciling them with the
old.

## Escalate rather than comply blindly

The ruling is explicit that this list is known symptoms, not an exhaustive spec,
and that blind implementation of a step-list is how the defect got in. If any
item conflicts with the operating model or with something real in this host —
particularly anything about how the shell's turn lifecycle interacts with a
continuously-draining scheduler — **say so and stop**, rather than forcing it.

## Report

Position against the full project. Lead with the mode change and what you deleted.
Then the four certification measurements. State plainly which previous-round tests
you removed or re-pointed and why. Full suite counts, both fmt gates,
`--all-targets` clippy attributed, hooks **6/6**, no seventh touchpoint, vendor
`e582465` untouched.

---

## Additions from the onboarding docs I had not been given

These come from `docs/onboard/` in the port repo — `03-decisions-brief.md`,
`04-host-pi-lhc.md`, and `bad-code-log.md`. Read them.

### The reference host confirms the shape exactly

`04-host-pi-lhc.md:54`: pi-lhc constructs the SDK **"always in background mode,
regardless of caller config, so derivation work drains automatically after each
intake commit"**, and **"Dispose awaits `drainSettled` by default so queued work
finishes before the handle is dropped."**

So: Background unconditionally, plus `drainSettled` at dispose. That is the whole
host-side drain surface. It confirms item 1 and item 3 above — do not add a config
knob for the mode.

### ToolResultSummary is a documented decision, not a port defect

`03-decisions-brief.md:24`, **DERIV-12**: *"Interim: tool_result_summaries are
forced to 500-char truncation (inference clogged the queue at intake rate); the
classifier-routed inference path is dormant pending a high-speed lane."*

Cite **DERIV-12** in MAPPING.md/FORK.md where we recorded the scope decision, and
drop any framing that suggests it is unresolved or awaiting a ruling. Note the
reason too — inference at intake rate clogged the queue — because it is the same
timing concern this repair addresses.

### Test philosophy — this is the recurring defect class, named

`bad-code-log.md` names precisely what has gone wrong six times here:

> *"Isolated permutation tests that bypass the real entry point… coverage
> inflation with reduced signal."*
>
> *"Special code whose only purpose is to isolate internal machinery for tests is
> usually a smell… The better direction is: keep any unavoidable helper close to
> the technical module being tested, keep it out of runtime product surfaces, and
> prefer tests that drive the real queue/derive/drain flow and assert durable
> outcomes."*

Apply it while doing this repair. **Remove the test-only seams built to poke
internals** rather than porting them to the new design:

- `TokenWatchSampler` and the cancel registry (`install_compact_cancel` /
  `compact_cancel_for`) — going away with item 4 anyway
- `SNAPSHOT_RACY` / `lookup_session_snapshot_racy` /
  `set_refresh_binding_racy_for_test` / `RegistrySnapshot::from_parts_for_test`
- `set_use_deterministic_inference_for_test` where a real path would do

Keep only what cannot be reached from a real entry point, and keep it beside the
module it tests. Replace what you remove with tests that **drive intake → turn
close → background drain → compact** and assert **durable outcomes**: what is in
the event log, what the view renders, what native holds after write-back.

The same log also names *"a public or configurable surface can imply behavior the
implementation does not actually use"* — which is exactly the cancel-registry
over-claim. Do not leave another one behind.

### A gap worth noting, not necessarily fixing now

pi-lhc validates each inference assignment at startup (`validateReachable`) and
surfaces unreachable lanes as a diagnostic — **never throws, capture keeps
running**. This fork has no equivalent: an unreachable derivation lane is
discovered only when a derivation fails. Say whether that belongs in this repair
or on the live runbook; do not silently add it.

---

## 7. Pin the invariant: compact runs no inference

Lee's standing point: **inference should almost never run in the compact path.**
Structurally verified — the port's compact (`thread_view/`) contains **zero**
references to `inference_callbacks` or any inference op. Inference lives only in
`shared_tech/durable_work/` and `shared_tech/derivation.rs`, i.e. the background
drain.

So inference in the compact path was entirely introduced by this fork's
`drain_derivations_before_compact`. Deleting it (item 2) removes all of it.

**Add a test that pins this**, because it is the invariant the whole repair
protects and it is cheap to assert: drive a real compact with a counting sampler
installed and assert **zero sampler operations during the compact call**.

Note this is a legitimate use of the counting sampler — it asserts a real
product invariant observed at a real entry point, not an internal mechanism.
That is the distinction `bad-code-log.md` draws, and it is why this one stays
while `TokenWatchSampler` and the cancel registry go.

If you find any remaining path where compact can trigger inference, **report it
rather than deleting it silently** — Lee said "almost never", so a legitimate
exception may exist and should be named rather than assumed away.
