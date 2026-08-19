# LIM-99 / S7 — compact-gating campaign certification evidence

Date: 2026-08-19 · Claude `2.1.235 (Claude Code)` · **Result: 8 of 9 canaries
pass; canary (d) partially fails — see the finding below.**

This record certifies the exact integrated compact-gating candidate
(S1–S6 accepted) through the nine end-to-end canaries in the S7 contract. It
supersedes nothing in
[`slice7-certification-evidence.md`](slice7-certification-evidence.md), which
remains the whole-product record for Claude 2.1.226; this document covers the
forward-only compact path and the latest-Claude recheck.

Everything below distinguishes **production proof** (real `claude` child, real
rollouts, real thread SQLite, real PTY under tmux) from **deterministic tests**
(vitest). One canary, (g), uses a child stand-in to make a replacement
deterministically nonviable; that arm is labelled where it appears and the
wrapper, capture, governor, registry and rollout handling are real throughout.

## Frozen artifacts

| Artifact | Identity |
|---|---|
| Source | `1b893993ae37b9ddaaaed0fcc9d1f45195d11c5c` on `campaign/cc-lhc-gating-lim-99`, worktree clean at every measurement |
| Contains | LIM-98 `5635943`, LIM-100 `340eaea` |
| Claude binary | `/home/leemoore/.local/share/claude/versions/2.1.235` · sha256 `bfcf0ae2dbf94b2b6a106074aabf3938b9a10889c3b678e4cb5a00c03274d5d5` |
| cc-lhc dist | 300-file sha256 manifest — `sha256sum -c` OK (300/300) after all exhibits |
| lhc (SDK) dist | 344-file sha256 manifest — `sha256sum -c` OK (344/344) after all exhibits |
| cc-lhc-native | 7-entry manifest incl. compiled `cc_lhc_identity.node` — OK (7/7); `CC_LHC_NATIVE_REQUIRE_ADDON=1` on every suite run |
| Node | v24.18.0 |
| State home | `/tmp/cc-lhc-lim99-1787144929/home` (isolated `CC_LHC_HOME`) |
| Exhibit root | `/tmp/cc-lhc-lim99-1787144929` |

Deps installed with `pnpm install --frozen-lockfile --filter cc-lhc... --filter lhc...`;
`pnpm-lock.yaml` unchanged. Build via direct `tsc`; no package-manager run scripts.

## Canary results

| # | Canary | Arm | Result |
|---|---|---|---|
| a | interactive over-trigger → compact → spawn-first swap → replacement live → typed-ahead dropped with notice | production | **PASS** |
| b | one-shot over-trigger → pre-launch compact → one launch → prompt answered on compacted session → pointer advanced | production | **PASS** |
| c | restart mid-swap → forward completion without revert | production | **PASS** |
| d | native `/compact` → notice plus captured closed turn → LHC continues | production | **PARTIAL FAIL** — LHC continues; notice and tagged closed turn do not occur |
| e | cc-lhc manual/panel compact remains distinct and succeeds | production | **PASS** |
| f | `autoCompact:false` suppresses automatic compact while manual compact still succeeds | production | **PASS** |
| g | repeated nonviability → persistent best-guess alarm → active R16 survival relaunch with native auto-compact enabled | stand-in child | **PASS** |
| h | old alias resolves to current; concurrent old/current alias launches yield exactly one thread owner | production | **PASS** |
| i | legacy interrupted journal/open-attempt state upgrades to forward completion with resend notice | production | **PASS** |

### (a) Interactive spawn-first swap — PASS

Thread `th_3df180f18af54b63`, sessions
`f93eb695 → e710ace9 → 44f3e5cd → 96520f66 → 77658af3 → e693a146 → 233acf23`,
tmux PTY, project config lower 30,000 / upper 60,000 / runway 20,000.

- Open-turn crossings classified only: `wouldMutate=false`,
  `handoffOutcome.kind=deferred_open_turn` — "Claude Code cannot replace the
  in-flight request mid-agentic-turn". 51 such receipts across the run.
- Settled seam at provider context **115,461** (input 2 + cache creation 23,673
  + cache read 91,786) ≥ trigger 60,000 → `would_compact`, `wouldMutate=true`.
- **Spawn-first ordering, verbatim from the log:**
  `candidate e710ace9 spawned off-route pid=2820777 (attempt 1)` →
  `handoff switch (auto_compact): f93eb695 -> e710ace9 (pid 2820777, session file written: true)` →
  `requested child termination pid=2818304` → `handoff success`.
  The old child is killed **after** the switch; a working session exists throughout.
- **Typed-ahead dropped with notice.** A watcher timed a six-keystroke operator
  burst into the ownership window: `dropped 107 typed-ahead byte(s) during
  compaction` (23 terminal-response bytes + 84 operator bytes = 6 × 14). The
  terminal showed *input typed during compaction was not delivered — please
  resend*; the prompt box was empty; `ZZTYPEAHEAD` appears in **0** message
  blocks across all four thread files — never buffered, never journalled,
  never replayed.
- **Smaller context, preserved content.** 115k/117k trigger context → rebuilt
  views of 913 and 52k tokens; the codeword `ALBATROSS-77` seeded in t1 was
  recalled correctly on the replacement child.
- **Pointer advanced** to the live session at every switch; all sessions remain
  aliases of the one thread.
- 7 successful handoffs across the whole run; **0 rollbacks** anywhere.

### (b) One-shot pre-launch compact — PASS

Thread `th_57f3de94affdfd1c`, cwd `b2`, lower 30,000 / upper 60,000.

- Invocation over the trigger: `one-shot pre-launch seam: would_compact —
  next-request pressure 71333 (last known provider 71316 + estimate 17) >=
  upperBoundTokens 60000` — the source-labelled estimate is never relabelled
  as provider usage.
- `one-shot pre-launch compact rebuilt: compact view=v4 tail=6 total=327`… →
  `compacted 10762daa -> 5134442f before launch; launching once with the
  original prompt`. **71,316 provider tokens → a 65-token rebuilt view.**
- **Exactly one launch:** the prompt text occurs **once** in the rebuilt
  rollout (record 7) and is answered at record 13.
- **Preserved settled content:** the answer is `PELICAN-99`, recalled from the
  smooth band of the rebuilt view.
- **Pointer advanced only on observed acceptance:**
  `prompt intake observed on 5134442f; thread th_57f3de94affdfd1c now current there`,
  and `thread_current_alias` names `claude-code:5134442f`.
- A companion thread (`th_e3e68bff9a74f7aa`) additionally showed the
  turn-that-grows-past-the-trigger rule: `wouldMutate deferred
  (one_shot_next_invocation)`, compacted by the next invocation.

### (c) Restart mid-swap → forward completion — PASS

The wrapper (pid 2818292) was `SIGKILL`ed **12 ms** after
`candidate 4ba2c100 spawned off-route pid=2844354` — inside the swap, after the
view was installed (`compact view=v45 … total=53899`) and the rebuilt rollout
was written, before routing switched.

On relaunch through the **oldest** alias `f93eb695`:

- The stale lease (dead pid 2818292) was reclaimed without a wedge.
- `f93eb695 is an older alias of thread th_3df180f18af54b63; landing on its
  current session 77658af3` — **not** the reserved `4ba2c100`.
- The reserved rollout is byte-identical before and after
  (`cec05e6d31e73b7bbd1c6c83f486b365a9e336a81448267c061947973bf541c4`):
  discarded from session selection, left untouched on disk, never activated.
- **No revert:** capture continued on the current session, and the next settled
  seam **re-materialized from the latest captured state** — a fresh rollout
  `e693a146` including the new `A-SEED-5` turn — and completed the swap forward.
- Clean `/exit` afterwards: exit 0, owner lease released (owners dir empty).

### (d) Native `/compact` — PARTIAL FAIL

What holds: **LHC continues.** The advisory notifier fired and did not block
(`notifier: holding Enter for /compact`; overlay "Claude /compact can invalidate
cc-lhc session capture/binding"). After the native compact, capture stayed
healthy, the governor kept observing (next settled seam `below_threshold`,
correctly reflecting the shrunk session), retrieval kept working — Claude
spontaneously ran `get-turns t1` through its own Bash tool and received the
`<recalled-history op="get-turns">` envelope with `<t1>`/`<m1>` content, and one
impression row was written (`t1`, served, 56 tokens).

What does not hold: **the notice and the tagged closed turn never happen.**

`src/intake/map.ts` discriminates a native summary as
`isNativeCompactSummaryLine(item) => item.type === "summary"`. Claude Code
2.1.235 writes no such record. A native `/compact` produces:

1. `{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"manual","preTokens":52141,"postTokens":1310,…}}`
2. `{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true, message:{role:"user",content:"This session is being continued…"}}`

Consequences observed on the exact candidate:

- No `native compact ran on a managed session` notice: **0** occurrences in
  `wrapper.log`.
- The summary was captured as an **ordinary user prompt** (`m31`, 2,927 chars,
  741 tokens) — **not** wrapped in `<claude-compact-summary>`, **not** bounded to
  2,000 chars, **no** `[... remainder of summary truncated]` marker.
- It landed in an **open** turn (`t6`), not the one complete closed turn R8
  specifies.
- The `compact_boundary` record is additionally swallowed by `isMetaLineType`
  (`item.type === "system"` → meta), so the boundary is counted as telemetry.

Corroboration beyond this run: across the whole real Claude Code corpus on this
box (106 project directories), `"type":"summary"` occurs in **0** files, while
`"isCompactSummary":true` occurs in 6 and `"subtype":"compact_boundary"` 10
times. The discriminator is a false negative in every observed case, so R8's
intake transform and its loud notice are unreachable in practice.

This is precisely the confirmation S6 deferred: the module comment states *"The
local rollout census carried no exemplar, so it is a recognized discriminator,
not a proven exhaustive one; S7 certification owns live confirmation."* The
confirmation is negative.

**Severity.** This is a fidelity and observability gap, not a stop: nothing
latches, nothing stands down, compaction stays armed, and the campaign's
load-bearing invariant holds. The minimal correction is to recognize the
installed shape (`isCompactSummary` on a `user` record, with
`subtype:"compact_boundary"` as the adjacent boundary marker) and to stop
classifying that boundary record as meta. That is an S6 repair and is
deliberately **not** made here — S7 must not repair S1–S6 under a certification
label. `packages/cc-lhc/README.md` and `docs/onboard/05-host-cc-lhc.md` both
describe the tagged, ~2,000-character, complete-turn behavior as current; this
record is the higher-precedence source until the discriminator is corrected.

### (e) cc-lhc manual/panel compact — PASS

Control panel (ctrl-\]) `compact` on a live session:
`handoff switch (compact): 96520f66 -> 77658af3` (note the operation label
`compact`, distinct from `auto_compact`), receipts
`[compact] compact view=v28 tail=51117 total=52107 smooth=990tok/3entries` →
`rebuilt session … written; handing off to a fresh Claude child` →
`handoff complete — session 77658af3 live`. The runtime note written into the
rebuilt session reads `[lhc compact:manual]`, distinct from `[lhc compact:auto]`
and from Claude's own native summary.

Panel status also reported: `native auto-compact: disabled for this child
(DISABLE_AUTO_COMPACT=1) · manual /compact still available`.

### (f) `autoCompact:false` — PASS

Project config `{"autoCompact": false, …}`; startup line
`context policy autoCompact=false … sources=autoCompact=project`.

- At a settled seam with provider context **121,941** against a 60,000 trigger
  (`atOrAboveTrigger=true`, `autoCompactIntent=false`): decision
  `policy_disabled`, reason `autoCompact is disabled`, `wouldMutate=false`, and
  **no handoff** — sanctioned stop #1, and the only automatic stop observed.
- **Manual compact still succeeds** on that same session:
  `handoff success (compact): session 233acf23 … live`, view total 55,059.

### (g) Repeated nonviability → alarm → R16 survival relaunch — PASS

Arm: `CC_LHC_CLAUDE_BIN` pointed at a stand-in that execs the real `claude`
except for a wrapper-owned replacement while a sentinel exists, which exits at
once so observable viability can never establish. Everything else — wrapper,
capture, governor, registry, rollout rebuild, spawn/route/kill machinery — is
the real candidate. The stand-in log independently confirmed that the inference
lane runs `claude -p --no-session-persistence`.

Three consecutive nonviable swaps (`d7948efc`, `e2192193`, `803c19f8`), each
with two internal attempts, each recorded as:

> replacement … never became viable (attempt 1: candidate exited; attempt 2:
> candidate exited); session d2255057 continues live — **nothing was switched
> and nothing was undone**

At the bound, both things happened at once and persist:

- **Standing alarm** on the terminal and in the log: *cc-lhc rebuilt sessions
  are not loading — likely a compatibility problem with the installed Claude
  version*, naming the evidence (*3 swap(s); last: attempt 1: candidate exited;
  attempt 2: candidate exited*), stating it is a **best guess** — *cc-lhc cannot
  observe whether Claude rejected the rebuilt file and never parses the terminal
  to find out* — and what still works: *Session d2255057 stays live and capture
  keeps running; only the automatic child swap stops. Manual compact still runs.*
- **Active R16 survival relaunch**, then and there: the stand-in recorded
  `NO_DISABLE_INJECTED argv=--resume d2255057-…` — the **old** session
  relaunched with the injected `DISABLE_AUTO_COMPACT` **absent**, so Claude's own
  compaction keeps it alive in degraded form.

The alarm's own claim was then verified: with the sentinel cleared, a panel
`compact` on the same session succeeded (`handoff success (compact): session
56f751d8 … live`, view total 832).

### (h) Alias resolution and single thread owner — PASS

- **Old alias resolves forward**, observed three separate times, e.g.
  `d2255057 is an older alias of thread th_60e4c349a0b7b2c4; landing on its
  current session 56f751d8`.
- **Concurrent launches through the old and the current alias of one thread**
  (`--resume d2255057` and `--resume 56f751d8`, started together): both resolved
  to thread `th_60e4c349a0b7b2c4`; exactly **one** took the thread-keyed lease
  and ran to completion (exit 0, answered `RACE-OLD`), and the other refused —
  `cc-lhc refused duplicate thread owner: LHC thread th_60e4c349a0b7b2c4 already
  has a live cc-lhc owner (pid 2909094)`, exit 2. One thread, one lease, every
  alias contending for it.

### (i) Legacy pre-rewrite state upgrades forward — PASS

Seeded into the isolated home before a launch on thread `th_60e4c349a0b7b2c4`:

| Seeded | Attribution | Expected |
|---|---|---|
| `recovery/input-ours-delivering.journal` (header names our sessions, state `delivering`) | ours | consumed |
| `recovery/handoff-ours.json` (retained-input artifact) | ours | consumed |
| `recovery/input-foreign.journal` (another thread's sessions) | foreign | untouched, silent |
| `recovery/handoff-unreadable.json` (unparseable) | unreadable | untouched, silent |
| `cc_governor_attempts` row `att-ours` (payload names our thread) | ours | settled |
| `cc_governor_attempts` rows `att-foreign`, `att-nothread` | not ours | left in place |

Observed on the launch, verbatim:

```
cc-lhc: found 2 retained-input artifact(s) from an earlier build in …/recovery (2 cleared)
cc-lhc: settled 1 interrupted handoff attempt row(s) from an earlier build
input typed during compaction was not delivered — please resend
LEGACY-UPGRADE-OK
```

Exit 0 — the launch completed forward, no wedge. The foreign journal and the
unreadable artifact are byte-identical afterwards
(`97c25fe6…`, `5904a5ca…`) and `att-foreign` / `att-nothread` remain in the
table. Another thread's state is never touched and never produces a notice
telling this operator to resend input that was never theirs.

## Sanctioned stops observed

Exactly two, both by design, across 85 durable governor receipts:

1. `policy_disabled` — the user's explicit `autoCompact: false` (canary f).
2. The bounded nonviability wall — automatic swaps stop after three nonviable
   replacements, with a standing alarm and an active survival relaunch
   (canary g). Nothing else stopped a compact anywhere in this run.

Receipt census: `would_compact/open_turn/wouldMutate=false` 51 ·
`policy_disabled/open_turn` 15 · `would_compact/settled_seam/wouldMutate=true` 10 ·
`below_threshold/settled_seam` 8 · `policy_disabled/settled_seam` 1.
14 off-route candidate spawns, 7 successful handoffs, 3 nonviable, **0 rollbacks**.

## Latest-Claude compatibility recheck

Every canary above ran on Claude Code **2.1.235**, ahead of the 2.1.226
certification baseline and the 2.1.232/233/234 `DISABLE_AUTO_COMPACT`
verification. Result: the rebuilt-rollout format, `--resume` handoff, session
selection, retrieval envelope, and `DISABLE_AUTO_COMPACT` injection all work on
2.1.235 — replacements resumed rebuilt sessions in ~1.1 s on every real-child
swap, and the panel confirmed the disable is in force with manual `/compact`
still available. The one compatibility defect found is the native-summary
discriminator in canary (d).

## Deterministic gates (this tree, at the certified boundary)

- `cc-lhc`: tsc (src + test) clean · vitest **91 files, 940 passed, 1 skipped**,
  with `CC_LHC_NATIVE_REQUIRE_ADDON=1`.
- `lhc`: `tsc -p tsconfig.json --noEmit` clean · vitest **71 files, 763 passed,
  31 skipped**.
- `lhc` **`tsc -p tsconfig.test.json` reports 4 pre-existing errors** in
  `test/chunk-compact-recovery.test.ts` and
  `test/compact-continuation-runtime.test.ts`. Proven pre-existing: restoring
  both files to merge-base `ff0a91c` reproduces the same four errors at the
  corresponding lines, so they predate the campaign and are outside S7's
  boundary. Not repaired here.
- The repo's `pre-commit` workspace typecheck (`pnpm -r run typecheck`) fails on
  the **untouched base commit**, for two reasons independent of this work:
  `lhc-convex`'s example typecheck cannot resolve `@liminal/lhc-convex` because
  that package is unbuilt in this worktree (out of scope for LIM-99), and `lhc`'s
  `tsconfig.test.json` carries the four pre-existing errors above. Verified by
  stashing to a pristine tree and rerunning. The documentation-only commit in
  this story therefore used the hook's own documented `LHC_SKIP_TYPECHECK=1`
  escape hatch, after the in-scope gates above were run and green.
- Manual prune needs no separate live canary per the S7 contract; its focused
  regression coverage is `test/commands/context-mutation.test.ts` (combined
  compact+prune with one view read and one rebuild; below-threshold skip; a
  failed due-prune reports but does not abort the compact),
  `test/commands/dispatch.test.ts`, and the modal/panel prune commands.

## Mutation evidence

Each probe mutates one shipped behavior, runs the targeted suite, and restores;
the worktree was verified clean after every probe.

| Probe | Result |
|---|---|
| `autoCompact:false` stop removed (`governor/decide.ts`) | 1 failed / 13 passed — killed |
| Legacy attempt-row thread scoping widened to "any row" | 2 failed / 9 passed — killed |
| Replacement viability check bypassed (switch before proving the candidate live) | 5 failed / 36 passed — killed |
| Typed-ahead resend notice silenced | 2 failed / 23 passed — killed |
| Duplicate thread owner allowed (conflict never raised) | 4 failed / 9 passed — killed |
| `NONVIABLE_SWAPS_BEFORE_ALARM` 3 → 99 | 6 passed — **survived**, by documented design |

The surviving mutant is deliberate: the module states the constant is "an
internal implementation constant, not a policy knob", the unit test asserts only
that the bound is greater than one, and the end-to-end suite injects its own
limit. The shipped value's behavior is therefore exercised by **canary (g)** and
nowhere else — which is exactly the gap live certification exists to close.

## Isolation and rollback readiness

- All canaries ran under an isolated `CC_LHC_HOME` (`/tmp/cc-lhc-lim99-1787144929/home`) and in
  disposable cwds under `/tmp/cc-lhc-lim99-1787144929/cwd/`.
- **Production `~/.cc-lhc` was never used and never mutated by this work.** Its
  `registry.sqlite` contains only a `threads` table — no `thread_alias` /
  `thread_current_alias` — i.e. it is a pre-S2/S5A build, structurally distinct
  from the isolated registry these canaries created. None of the canary threads
  or session aliases appear in it. Writes to that directory during the window
  belong to the separate operator wrapper running on this box.
- No global install, no launcher switch, no gateway change, no release, no push.
  The candidate exists only as `dist/` inside this worktree.
- Rollback readiness: nothing outside the worktree and the disposable exhibit
  root was created or changed, so rollback is deleting the exhibit root and the
  five disposable Claude project directories. The exact remaining step before
  local installation/dogfood is the steward's separate authorization of the
  immutable rollback-safe install phase; no part of it was performed here.

### Disposable targets (recorded before cleanup)

```
/tmp/cc-lhc-lim99-1787144929
~/.claude/projects/-tmp-cc-lhc-lim99-1787144929-cwd
~/.claude/projects/-tmp-cc-lhc-lim99-1787144929-cwd-a
~/.claude/projects/-tmp-cc-lhc-lim99-1787144929-cwd-b
~/.claude/projects/-tmp-cc-lhc-lim99-1787144929-cwd-b2
~/.claude/projects/-tmp-cc-lhc-lim99-1787144929-cwd-g
```

Isolated threads created: `th_e3e68bff9a74f7aa`, `th_57f3de94affdfd1c`,
`th_11faae96876d7feb`, `th_3df180f18af54b63`, `th_60e4c349a0b7b2c4` — all inside
the exhibit root.

---

## Amendment — 2026-08-19, after the record above: canary (d) rerun and passing

Everything above this line is the original certification run and stands
unchanged, including the canary (d) **PARTIAL FAIL** receipt and the summary
table. This section is appended chronologically after it; it does not relabel
that result, which remains the true outcome on the base it ran against
(`86d41a1c4a0abd1a629a89b83b816c4dd856cd0b`).

**Correction commit:** `48ef4b1ef2a7eb9a5471fd2d9cc639512ccad808`
(`fix(cc-lhc): recognize the installed native-compact summary shape`), the S6
repair canary (d) identified and deliberately did not make.

The discriminator now recognizes the installed Claude Code 2.1.235 shape —
top-level `type: "user"`, `isCompactSummary: true`, `message.role: "user"`,
string `message.content` — alongside the retained legacy `type: "summary"`
shape, with observation and intake sharing one function. The adjacent
`system`/`subtype: "compact_boundary"` record stays harness metadata exactly as
before; no pairing state, adjacency inference, latch, or stop was added.

Deterministic evidence added with the correction: fixture
`test/fixtures/native-compact-2.1.235.jsonl`, a structural copy of lines 21–22
of this record's own canary (d) exhibit rollout (session
`77658af3-c016-4acf-886f-2bb27498886e`), sanitized only by replacing absolute
home paths inside strings. Focused suites 109 passed; full `cc-lhc` package
suite **92 files, 952 passed, 8 skipped**; both `cc-lhc` typechecks clean; core
`lhc` suite 759 passed / 15 skipped. Mutation: reverting only installed-shape
recognition fails 6 tests across the intake, observation, and wrapper suites;
restored byte-exact (sha256 verified).

### (d-amended) Native `/compact` on 2.1.235 — PASS

Rerun from the correction commit against the same installed binary, in a fresh
disposable sandbox. Command:

```text
tmux -f /dev/null new-session -d -s r8canary -x 200 -y 50 -c /tmp/cc-lhc-r8-canary-1787148295/cwd \
  "CC_LHC_HOME=/tmp/cc-lhc-r8-canary-1787148295/home CC_LHC_CLAUDE_BIN=/home/leemoore/.local/bin/claude \
   node <worktree>/packages/cc-lhc/dist/bin.js"
```

- Claude session: `eea0cf54-4169-466f-8865-6b478be7646e` · LHC thread `th_115a6b388913dd47`
- Rollout: `~/.claude/projects/-tmp-cc-lhc-r8-canary-1787148295-cwd/eea0cf54-4169-466f-8865-6b478be7646e.jsonl`
  — contains `"isCompactSummary":true` ×1 and `"subtype":"compact_boundary"` ×1,
  and `"type":"summary"` ×0, i.e. exactly the shape that defeated the original run.

Three seeded turns, then a user-typed native `/compact`.

1. **Advisory notifier still warns and still does not block** — overlay
   "Claude /compact can invalidate cc-lhc session capture/binding", Enter
   continues. Unchanged from the original run.
2. **Loud notice — now fires, exactly once.** `wrapper.log`:
   ```text
   2026-08-19T14:10:38.492Z [warn] cc-lhc ANOMALY: native compact ran on a managed session — This session is being continued from a previous conversation that ran out of context. …
   ```
   Original run: **0** occurrences.
3. **Tagged, bounded, complete closed turn — now lands.** Thread SQLite:
   turn `t4` `status=closed`, `outcome=completed`,
   `outcome_reason=claude_native_compact_summary`, exactly one member `m9`
   (`kind=user_prompt`), content opening `<claude-compact-summary>` and closing
   `</claude-compact-summary>`, 1,905 code points — under the 2,000-code-point
   bound, so no truncation marker, which is the correct behavior for a summary
   this size. Original run: an **open** turn holding a 2,927-char ordinary
   untagged prompt.
4. **No duplicate.** Exactly one message in the thread carries the summary text,
   and it is the tagged one; zero untagged copies. The `/compact` slash line
   itself is captured separately and ordinarily as `m8` in `t3`.
5. **LHC continues — unchanged and re-proven.** Capture stayed healthy
   (`capture ready (gen 1)`, no degradation), and a settled-seam observation at
   `14:12:09` — **after** the 14:10:38 anomaly — recorded
   `decision=below_threshold` at next-request pressure **23,057**, correctly
   reflecting the shrunk session (25,434 before the compact). A post-compact
   turn answered from compacted context (`HALYARD-95` recalled correctly).
   Nothing latched and nothing stood down.
6. Clean `/exit`: wrapper exit 0, owner lease released (owners dir empty),
   `derivations_pending=0`.

With this, all nine S7 canaries pass on Claude Code 2.1.235: the eight from the
original run, plus canary (d) at the correction commit. The `README` and
`docs/onboard/05-host-cc-lhc.md` native-summary paragraphs are accurate again as
of `48ef4b1`.

### Amendment isolation

- Isolated `CC_LHC_HOME` (`/tmp/cc-lhc-r8-canary-1787148295/home`) and disposable cwd (`/tmp/cc-lhc-r8-canary-1787148295/cwd`); no
  operator session, no production `~/.cc-lhc`.
- Production `~/.cc-lhc` fingerprinted before and after the rerun —
  `cc-lhc.sqlite` and `registry.sqlite` sha256 **identical**.
- Rebuilt only disposable worktree artifacts (`packages/lhc` dist,
  `packages/cc-lhc` dist, and the `cc-lhc-native` addon via `node-gyp rebuild`).
  `pnpm-lock.yaml` sha256 unchanged across the whole amendment.
- No push, install, release, publication, gateway change, or service restart.

Amendment disposable targets:

```text
/tmp/cc-lhc-r8-canary-1787148295
~/.claude/projects/-tmp-cc-lhc-r8-canary-1787148295-cwd
```
