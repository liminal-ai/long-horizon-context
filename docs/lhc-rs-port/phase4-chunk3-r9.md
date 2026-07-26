# Phase 4 / Chunk 3 — round 9: fix the recovery drill and the abort leak

Resume the same session (you did Phase A). **Do not commit, do not push.**
Position: **unit 22 of 22.** Still Phase A rules: **no live model calls.**

Your Phase A report was good work. Three findings needed rulings; two of them
I can settle from the fork's own documents, so they are now instructions. The
third (Phase B budget) is with Lee.

---

## N1 — The patch series has the wrong base. Regenerate it against upstream.

You asked what the series is *for*. `patches/lhc/README.md` already answers:

> Regenerate after any hook change (same commit as the hook):
> `# From a clean base (upstream tip) ...`
> `git diff upstream/main -- codex-rs/Cargo.toml > patches/lhc/0001-...patch`

and `FORK.md:152-154` defines the drill: restore the fork-owned tree →
`git apply patches/lhc/*.patch` → tripwires green → force-push. So the series
is a **recovery mechanism**, and every patch must be a diff **from the
upstream base**, not from an intermediate fork commit.

**The upstream base is `322d5b96cf`** ("Keep unified mention results fresh
(#35365)") — the last upstream commit before Chunk 0 (`8e85a2c606`). I
verified that with `git log --first-parent`.

That single fact explains all four of your defects: R1 (no single base) and
R2 (`0006` matches no fork commit) are the series having been regenerated
piecemeal against whatever `HEAD` happened to be.

**Do:**

1. Regenerate the **whole series** `0001..0007` as
   `git diff 322d5b96cf -- <files for that patch>`, keeping the existing
   per-patch file grouping (one patch per touchpoint set, per FORK.md's
   inventory). Use `git add -N` first so untracked fork-owned files appear.
2. **Fix R3:** the four fork-owned core files in no patch must be in one.
   `lhc_band_shape_eval_tests.rs` especially — `0007` declares its `mod` but
   the file is absent, so the drill produces a tree that cannot compile.
   Cross-check the result against FORK.md's touchpoint inventory; if a file
   is fork-owned and not in a patch, that is a defect in either the patch or
   the inventory. Say which.
3. Prove it: `git worktree add --detach <tmp> 322d5b96cf`, apply the series,
   and diff **every** fork-owned file against the working tree. Byte-identity
   or it is not fixed. Paste the comparison.

---

## N2 — Fix layer 13 so it is meaningful after a commit

You are right that `patch-repro` as written can only be green pre-commit:
it applies `0007` to `HEAD`, and once the work is committed `HEAD` already
contains it. That is my design error, and it means the tripwire has been red
on the committed tree since `3aa3a44d22` landed. I confirmed that myself.

**Rewrite the layer to test the drill it is actually guarding:** apply the
**whole series** to a detached worktree at the **upstream base**
(`322d5b96cf`), then diff every fork-owned file against the live tree. Green
means "the recovery drill reproduces this tree." That is true both before and
after a commit, which is the property the layer needs.

Keep the failure output actionable — name the first file that differs and
show a short diff, as it does now.

---

## N3 — Stop spending on a turn the user abandoned

Your §5.2. You framed it as a spend decision for Lee; I am ruling it, because
"stop working when the user hits abort" is not a judgment call. The
measurement makes it concrete: **3 inference calls at abort, 12 by 500 ms
later**, still climbing against a 75 s budget, for a turn the user walked
away from.

Upstream paying this for one model call is not a precedent for us paying it
for ~2 calls per turn of derivation.

**Do:** propagate the real turn cancellation into the LHC arm so an abort
stops derivation promptly — the same mechanism M2 already uses for the
timeout path, driven by the turn's own token rather than only the arm's
private `AtomicBool`. `CompactTask::run` binds `_cancellation_token`; if
threading it through requires a small upstream-shaped change, mark it with an
`LHC-HOOK` sentinel, add it to the inventory and the patch series, and say so.

Fail open per law 3 when cancelled: no partial install, no marker.

**Test:** cancel the turn token with derivation in flight; assert calls stop
promptly (bound it — e.g. no further calls after a short grace) and that
nothing is installed. Must fail if the propagation is removed.

---

## Standing bar

- Mutation-prove each of N1/N2/N3: break it, paste the real failure, restore,
  re-pass.
- Tests round-trip the production path. No `include_str!`.
- **No live model calls.** Phase B stays blocked.
- **Never** run workspace-level `cargo fmt` — it dirties the vendored pin.
- Do not commit, do not push.

## Report

Short. Per item: what changed, mutation output, and the byte-identity
comparison for N1. Then re-run the full tripwire and paste the layer list.
Update `CHUNK3-CERTIFICATION.md` §1 and §4 so the headline reflects reality
after these fixes — including, if it is true, that the drill now works.
