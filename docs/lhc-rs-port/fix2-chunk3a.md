# Chunk 3A fix round 2

**Chunk 3 of 3, Phase 3 of 4 — unit 18 of ~22.**

Split verdict. One lane PASSed after re-establishing all three Y1 probes
independently; the other found five blocking items. I adjudicated against
source rather than by vote — four are real product defects, and the fifth is a
genuine conflict between two requirements that needs deciding rather than
patching.

**Both lanes refuted the registry-lifetime concern I raised, with probes.** The
cleanup exists in `LhcTeePersistence::drop` (`tee.rs:102-113`) → `shutdown_async`
→ worker exit → `unregister_worker`. A 12-session probe showed threads peaking
at 3 and returning to baseline 2, `ACTIVE_CAPTURES` at zero. One lane also
established that `Weak` never provided the backstop I assumed — the entry and
counter always depended on the same chain. **No work needed. Do not "fix" this.**

Y1–Y7 are all confirmed fixed by both lanes. The items below are new.

---

## Z1 [blocking] `/lhc off` keeps reporting LHC as the active engine

Status now prioritises the last serve outcome (`status.rs:111`), which was the
right fix for Y2 — but **disabling a session does not clear that outcome**, and
the clear function is test-only. A verifier confirmed with a temporary test:
after an LHC serve outcome, removing capture still yields
`ContextEngine::Lhc`.

So `/lhc off` reports LHC until some later serve turn overwrites it — and if no
further serve happens, indefinitely. That is the same dishonesty Y2 existed to
remove, in the opposite direction.

Clear the outcome on disable, via a production path rather than a test-only
one. Also: the outcome map retains entries for ended sessions indefinitely —
evict on session end.

## Z2 [blocking] Mid-session `/lhc on` still hides the missing compaction capability

The slash path spawns capture with `sampler: None` (`slash_exec.rs:130`).
Capture now works after Y1, but ModelCall compaction may stay unavailable until
a new session spawn.

**This is blocking by the criterion I set last round**, not a new judgement: a
capability gap the status surface *hides* is blocking, one it *reports* is
carryable. Neither the enable response nor `/lhc status` mentions it.

Preferred: make mid-session enable acquire the sampler so the capability is
real. If that is genuinely not reachable from the slash path, then **say so in
both places** — the enable response and status — naming what is unavailable and
that a new session restores it. Do not leave the user to discover that compact
silently does nothing.

## Z3 [blocking] A stuck worker reports `Health: ok`

RPC timeouts add explanatory notes, but the final `ok` computation ignores
timeouts and errors (`status.rs:252`, `status.rs:318`). A registered worker that
times out on **both** inspection calls is still reported healthy.

Health must incorporate the timeout/error outcomes it already collects. A note
next to a green light is not a health signal.

## Z4 [blocking] Status reads the entire database to check its magic bytes

Schema validation uses `std::fs::read(path)` (`status.rs:129`) to inspect the
SQLite header. **The event log is designed to hold full-fidelity history** — so
`/lhc status` allocates the whole database. On a long-lived thread that is
severe latency, and on a big one an OOM, triggered by a status command.

Read only the fixed-size header. Check the header length is present before
indexing, and keep the version check.

## Z5 [decide, then document precisely] Off-by-default now costs one atomic load

The tee is installed **unconditionally** (`tee.rs:41`), so a disabled session
runs `any_capture_active()` per persistence call. One lane calls this a
violation of the absolute rule: *behaviourally identical, no added per-turn
work*.

I verified the disabled path at source: **one relaxed atomic load plus a `Box`
indirection.** No mutex, no registry lock, no I/O, no spawn — the L3 fast path.

I am ruling to **keep the unconditional tee**, and here is the reasoning to
record rather than my authority for it:

- Removing it when disabled makes `/lhc on` impossible mid-session, because
  nothing can install a tee into a running actor. Per-session enable is a named
  rollout-safety requirement (A5), so dropping it fails a different requirement.
- The law was written after Chunk 2's L3 defect, where `capture_active()` took
  a **registry mutex every turn** while disabled. Its target was meaningful
  per-turn work. A relaxed atomic on a path that already performs disk
  persistence is not that.
- One lane observes the unconditional tee is what makes teardown cover *more*
  sessions than before: a session spawned LHC-off previously had no tee, so a
  later `/lhc on` left a worker with no drop-owner.

**What you must do — this is the actual work item.** Do not leave a stated
absolute silently contradicted:

1. **Measure it.** Add a test or bench establishing the disabled-path cost per
   persistence call, and report the number. If it is not negligible against
   native persistence, stop and report — the ruling was made on the premise
   that it is.
2. **Restate the law precisely** in MAPPING.md and FORK.md: no I/O, no lock, no
   allocation, no spawn, no behavioural difference when disabled — and name the
   one atomic load as the measured exception, with the A5 reason it exists.

Flagging this to Lee as a design-shaped decision on a standing law. It is
in-fork, revertible, and changes no hook or touchpoint, so I am proceeding
rather than blocking on it.

---

## Report

Position against the full project. Give the Z5 measurement explicitly. Full
suite counts, both fmt gates, `--all-targets` clippy attributed. Confirm hooks
stay 6/6, no seventh touchpoint, vendored port untouched. If any item cannot be
done without a new hook or a port change, **stop and report** rather than
widening scope.
