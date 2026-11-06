---
name: verify-cc-lhc
description: "Verify cc-lhc (the Claude Code wrapper in packages/cc-lhc) the way a user runs it: built wrapper in an isolated tmux PTY with a throwaway HOME, scripted Claude session capture, rebuild, and Smart Compact drives. Use when proving cc-lhc wrapper, capture, rollout, panel, or Smart Compact behavior end to end; never against the operator's real Claude config or ~/.cc-lhc."
---

# Verify cc-lhc

Surface: `cc-lhc`, the production Claude Code host in `packages/cc-lhc`. It
wraps the closed `claude` CLI (PTY for interactive sessions, plain child for
`-p` one-shots), captures Claude's rollout JSONL into an LHC thread, and
rebuilds the session from the thread's compacted view (Smart Compact) when
context pressure reaches the trigger or the user runs `/smart-compact`. A user
touches the `cc-lhc` command, the forwarded Claude UI, and the Ctrl-`]`
control panel. There is no server to keep alive: launch means build once,
then start each drive in its own isolated tmux PTY session.

Isolation facts, from the code (read them before driving):

- State root is `CC_LHC_HOME` (default `~/.cc-lhc`):
  `packages/cc-lhc/src/intake/paths.ts`.
- Transcripts resolve from `homedir()/.claude/projects`, **not**
  `CLAUDE_CONFIG_DIR`: `packages/cc-lhc/src/rollout/discover.ts`,
  `write-rebuilt.ts`, `src/intake/launch-session.ts`. A throwaway `HOME`
  is therefore the isolation boundary. Every wrapper command a helper
  runs goes through `iso_env` or `iso_cmd_env` (`helpers/lib.sh`), which
  also set `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME` under it, so a real
  `claude` child and cc-lhc's `cc-lhc/config.json` lookup stay isolated,
  and unset `CC_LHC_RUNTIME_DESCRIPTOR` (a live-session capability; never
  set it manually).
- `CC_LHC_CLAUDE_BIN` overrides the child binary. Seeded drives point it at
  the repo's stand-in, `packages/cc-lhc/test/fixtures/oneshot-claude.mjs` —
  the production boundary where cc-lhc already isolates the closed binary.
  The capture drive wraps it in `helpers/capture-bound-claude.mjs`, which
  stays up until capture binds, so the one-shot is actually ingested.
  That proves wrapper behavior; it does not prove a real Claude launch.
- Never use the operator's real `~/.claude`, `~/.cc-lhc`, credentials, or
  production data. Helpers refuse to run without a throwaway HOME.

## Launch

Build once from the repo root (order matters: `cc-lhc` type-checks against
`cc-lhc-native`'s dist, and every real launch needs the native addon):

```sh
pnpm install --frozen-lockfile
pnpm --filter lhc run build
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run build:native
pnpm --config.verify-deps-before-run=false --filter cc-lhc-native run stage:prebuild
pnpm --filter cc-lhc run build
node packages/cc-lhc/dist/bin.js --lhc-version   # expect first line: cc-lhc 0.4.5
```

Without the addon a launch exits 2 with `cannot establish process identity
... addon_unavailable` — expected fail-closed behavior, not a drive failure.
Launch reaches a usable state from an empty data dir. Each drive makes a
throwaway HOME with `work/` and `.claude/`, and the first session launch
creates `$ISO_HOME/.cc-lhc` (registry, lineage DB, thread store) and the
`.claude/projects/<encoded cwd>/` transcript dir. `helpers/doctor.sh`
only runs `--lhc-version` and creates neither. Ready means
the wrapper owns a thread and the child answered, not merely that a process
started. Teardown is in Cleanup below.

## Doctor

One read-only worth-driving check. Run it first whenever anything looks off:

```sh
.agents/skills/verify-cc-lhc/helpers/doctor.sh
```

It checks Node ≥ 24.3, tmux, the built `dist/bin.js`, the staged native
addon, the stand-in fixture, and runs `--lhc-version` under a throwaway
HOME. It writes nothing outside its temp HOME and the evidence dir. Pass
line: `VERIFY-CC-LHC doctor: PASS`.

## Drive

Harness: isolated tmux PTY per drive (`helpers/lib.sh`, `run_in_tmux`).
Each drive starts in `$ISO_HOME/work`, waits deterministically for the
command's exit-code file (never a fixed sleep to guess readiness), captures
the pane, and kills only its own session. One-shots run Claude as a plain
child per the product contract; the wrapper still runs inside the PTY.

Seeded drives (each prints `VERIFY-CC-LHC <name>: PASS`):

```sh
.agents/skills/verify-cc-lhc/helpers/drive-help.sh          # --lhc-help (700k/120k policy) / --lhc-version / unknown-flag exit 2
.agents/skills/verify-cc-lhc/helpers/drive-capture.sh       # scripted session capture (-p, stand-in Claude)
.agents/skills/verify-cc-lhc/helpers/drive-rebuild.sh       # rollout write -> --resume the rebuilt session
.agents/skills/verify-cc-lhc/helpers/drive-smart-compact.sh # forced-bounds one-shot Smart Compact (may SKIP, exit 3)
.agents/skills/verify-cc-lhc/helpers/run-seeded-drives.sh   # all of the above, timed; 10-minute budget together
.agents/skills/verify-cc-lhc/helpers/probe-checks.sh        # broken-case probes: capture and rebuilt-content checks must fail on broken input
```

`probe-checks.sh` is not part of the seeded set. Run it whenever a
capture or Smart Compact assertion, or a helper they use, changes. It
writes each case's output under `probe/` in the evidence dir and prints
`VERIFY-CC-LHC probe-checks: PASS` only when every broken case fails for
its named reason and every good case passes.

`drive-rebuild.sh` and `drive-smart-compact.sh` seed their precondition
with `helpers/seed-thread.mjs` (an LHC thread with two settled text-only
turns through `messageEvents` and `drain`, as
`test/commands/rollout-write.test.ts` does, minus that test's tool call and
tool result, so neither drive writes tool lines). Seeding
is a precondition, never proof; the drive itself is the real CLI surface.
The rebuild drive passes `--envelope-from` a checked-in 2.1.226 rollout
fixture and grades that the rebuilt lines carry its `version`.

Live-Claude drives (credentials required; not seeded): to prove a real
interactive session, Smart Compact handoff, or the control panel, launch
the built wrapper in tmux with `HOME`, `CC_LHC_HOME`, `CLAUDE_CONFIG_DIR`
all under a fresh dir in the scratch root (see Evidence), authenticate
**inside that throwaway config only**, then drive per
[features/smart-compact.md](features/smart-compact.md)
and [features/control-panel.md](features/control-panel.md). Auth is either
a Claude login inside the throwaway config, or env auth in the tmux shell:
`iso_cmd_env` keeps the shell's `ANTHROPIC_*` variables, and the Claude
child reads them. A live drive on 2026-11-02 ran on `ANTHROPIC_AUTH_TOKEN`
with `ANTHROPIC_BASE_URL`. Keep the values out of the pane: write them to
a mode-600 file under `$ISO_HOME`, and have the pane command source it and
delete it before launching. With neither available, record the drive as
skipped with that reason. Do not copy or read the operator's real Claude
config to get credentials.

## Evidence

Run folder `<run>` is `$VERIFY_RUN_DIR`, default `.pstack/runs/verify-cc-lhc`
in the main checkout (the first entry of `git worktree list`; `.pstack/` is
git-ignored). Throwaway HOMEs go under the scratch root
`$VERIFY_SCRATCH_ROOT`, default
`${XDG_STATE_HOME:-$HOME/.local/state}/verify-cc-lhc/scratch`; nothing goes
to `/tmp`. The root stays outside any repo because a HOME's `work/` dir is
the session cwd, and Claude loads each `CLAUDE.md` and `AGENTS.md` above
it. Evidence dir: `${VERIFY_CC_LHC_EVIDENCE:-<run>/proof}`.
Every drive appends `PASS:`/`FAIL:`/`SKIP:` lines to `results.txt`, saves
its command log (`capture.log`, `rebuild.log`, …), its tmux pane capture
(`<drive>-pane.txt`, the terminal transcript), the ISO `wrapper.log`, and
the transcript JSONL it graded. `run-seeded-drives.sh` adds `timings.txt`
(per-drive and total wall time; budget 600s together, warm). Receipts in a
verdict, a PR or a report cite files under `<run>/proof/` only, never a
scratch dir.

Proof standards:

- Exercise the real user path (wrapper CLI, panel, resume), not internal
  setters. The stand-in Claude only replaces the closed binary at the
  `CC_LHC_CLAUDE_BIN` boundary cc-lhc itself defines; seeding a thread is
  a labeled precondition.
- Capture the action and the resulting state: stdout/exit code **and**
  side effects (transcript lines, thread/registry DBs, wrapper.log).
- A **user-only check** gets only the terminal and cc-lhc's own help text:
  run the prompt or panel command and read what a user reads (reply,
  panel, receipt lines). It never gets session-file paths or DB state.
- An **outcome check** runs beside it and grades what the user cannot
  see: transcript growth, new session ids, lineage, capture-summary and
  wrapper.log lines. Each seeded drive names both in its header comment.
- The feature map in [features/README.md](features/README.md) is the
  maintained source. A proof through one entry point is incomplete when
  the map lists others; report unreached entries, do not call them passed.

## Cleanup

```sh
.agents/skills/verify-cc-lhc/helpers/cleanup.sh
```

Removes the throwaway HOMEs recorded in `iso-homes.txt` in the evidence
dir. Each drive kills its own tmux session by exact name when its command
exits or times out, and again on the drive's exit; `cleanup.sh` runs in a
new process and cannot see an earlier drive's session name. A tmux session
you started by hand for a live drive is yours to kill by the name you gave
it, never by pattern. It refuses any path that
is not a `verify-cc-lhc-home-*` dir under the scratch root. Remove a HOME
through this helper, never a raw `rm`. Evidence survives cleanup at the evidence
dir above — confirm `results.txt` and the pane captures still exist after
cleanup before reporting a drive done.

## Capture and publish

A PR that changes what a user sees (the panel, the forwarded pane, help or
receipt text) carries before-and-after screenshots or videos in one PR comment. The
verifier makes them while it drives the change, parent against head, and the
lead opens each one at acceptance. The scripts live in `.agents/verify-media/`,
shared with `verify-cc-lhc-mod`. Run them from the head checkout.

1. Build a clean checkout at the PR's head and one at its merge base
   (`git merge-base origin/main <head>`), each per Launch. Every capture
   records its checkout's commit, and `publish.mjs` refuses a run whose head
   side is not the PR's current head, whose base side is not the merge base,
   or that a checkout made while `git status` showed changes. That is the
   whole dirty check: a file Git hides from `git status` (an
   `assume-unchanged` or `skip-worktree` index flag) passes it. Root
   `pnpm run test` writes only `build/story0/`, which Git ignores.
2. Drive the same steps on each side under a throwaway HOME, and capture each
   step's screen from its tmux session. Steps pair by name. The panel preview
   is a real screen that needs no auth (`$co` is the side's checkout,
   `$side` is `base` or `head`, `$media` is
   `<main checkout>/.pstack/runs/<run>/proof/media-<pr>`):

   ```sh
   source .agents/skills/verify-cc-lhc/helpers/lib.sh && make_isolation
   s="cc-lhc-media-$side-$$"
   tmux new-session -d -s "$s" -x 100 -y 30 -c "$ISO_HOME/work" \
     "$(iso_cmd_env) node $co/packages/cc-lhc/dist/bin.js preview --fixture normal-first-launch --geometry normal --raw; exec sleep 600"
   node .agents/verify-media/capture.mjs --checkout "$co" --session "$s" --side "$side" \
     --step panel-first-launch --wait-for "Long Horizon Context" "$media"
   tmux kill-session -t "=$s"
   ```

   For a live panel drive, run `capture.mjs` on the live session at the step
   the PR changes, such as `/status` drawn after a settled turn. It writes
   `<side>/<step>.png`, the pane text as `<step>.txt`, and `<step>.json`
   with the commit, the side's run id and the sha256 of the PNG and the
   text. The first capture into a side makes its run id, so capture each
   run into a fresh `$media`. It refuses, and writes nothing, when the pane
   shows a token-shaped string (`sk-…`, `ANTHROPIC_AUTH_TOKEN`, `Bearer …`,
   a secret-named `KEY=value` assignment, a JWT, GitHub, Slack or AWS key
   shapes), checking the text as shown and with line breaks removed, so a
   token the terminal wraps mid-word still refuses. A token split by a
   box border the app draws (`│`) is not caught, so never drive a screen
   that shows a credential. Never capture a screen showing a real person's
   data; the throwaway HOME rules above keep the operator's own out.
3. Publish:

   ```sh
   node .agents/verify-media/publish.mjs --pr <n> --title "verify-cc-lhc control panel" \
     --note "<what the PR changes on this screen>" "$media"
   ```

   It uploads each PNG to Cloudflare Images on the Liminal.builder account
   (`CLOUDFLARE_ACCOUNT_ID`, default `e8e382d5bf8ec24ee2125188819b995c`)
   through the `cf` CLI, under `lhc/<random uuid>/`, as unsigned URLs by
   the lead's decision, since they show only disposable test data and signed
   URLs expire inside GitHub. It fails unless each public URL serves a PNG
   of the uploaded size. Before any upload it refuses a PNG or text whose
   hash differs from its `<step>.json`, and a side whose captures carry more
   than one run id. That proves the files belong together, not that both
   sides drove the same actions. It then adds or updates the one comment
   marked `<!-- lhc-captures -->` that the `gh` user wrote, base and head
   side by side per step with both commits named, and never edits another
   author's comment. It checks that comment's state before uploading, and
   refuses state it could not have written. Its `published.json` makes a rerun upload nothing and
   update the same comment in place. A run on a new head replaces the old
   head's runs.
4. Link the comment in the review. `.agents/verify-media/probes.sh` runs the
   broken cases (token shapes on screen, dirty checkout, wrong commit,
   swapped PNG, mixed runs, another author's comment, broken comment state,
   failed upload, URL that does not read back, a video changed after capture
   or outside the run dir, a failed video upload, a video that never becomes
   ready, rerun) against a real PR.

For a change that moves (a spinner, a transcript notice that appears, a
panel redraw), record a video instead of a screenshot at that step. Add
`--record <seconds>` to the same `capture.mjs` call, start it, and drive the
session from another shell while it records:

```sh
node .agents/verify-media/capture.mjs --checkout "$co" --session "$s" --side "$side" \
  --step compact-notice --record 8 "$media" &
tmux send-keys -t "=$s" '/compact' Enter
wait
```

It samples the screen every 200 ms and writes `<step>.mp4`, every distinct
frame's text in `<step>.txt`, and `<step>.json` with the same commit, run id
and hashes a screenshot gets. It refuses, and writes nothing, when any
frame's text is token-shaped. The video is encoded only from those frames,
so a screen that showed for less than 200 ms is in neither the video nor the
check. A step is a PNG or a video on both sides, never one of each.
`publish.mjs` gives a video the same checks as a PNG, and refuses one that
resolves outside the run dir. It uploads the video to Cloudflare Stream
through a one-time direct upload URL from `cf stream videos direct-upload
create`, so no API token leaves the `cf` CLI. The video is unsigned for the
same reason the screenshots are, and Stream deletes it after 90 days because
storage is metered. The publish waits up to `--ready-timeout` seconds
(default 300) for `readyToStream` with a duration, then checks that the
thumbnail, the HLS manifest and the watch page serve. A video that never
becomes ready fails the publish and posts nothing. The comment shows the
video's last frame as a thumbnail linked to its Stream watch page, base and
head side by side. `published.json` records each upload as it lands, so a
rerun after a failure waits on the same video instead of uploading it again.

## Helpers

All under `.agents/skills/verify-cc-lhc/helpers/`, all executable:

| Helper | Invocation | Purpose |
| --- | --- | --- |
| `helpers/lib.sh` | sourced by the others | Run folder, isolation, guarded HOME removal, tmux drive, PASS/FAIL bookkeeping |
| `helpers/doctor.sh` | `helpers/doctor.sh` | Read-only worth-driving check |
| `helpers/drive-help.sh` | `helpers/drive-help.sh` | Help/version/unknown-flag drive |
| `helpers/drive-capture.sh` | `helpers/drive-capture.sh` | Scripted session capture drive |
| `helpers/drive-rebuild.sh` | `helpers/drive-rebuild.sh` | Rebuild + resume drive |
| `helpers/drive-smart-compact.sh` | `helpers/drive-smart-compact.sh` | Forced-bounds Smart Compact drive (exit 3 = SKIP with reason) |
| `helpers/capture-bound-claude.mjs` | `CC_LHC_CLAUDE_BIN` for `drive-capture.sh` | Runs the repo stand-in, then waits for `cc-lhc capture ready` in `wrapper.log` |
| `helpers/check-rebuilt-content.mjs` | `node helpers/check-rebuilt-content.mjs --source OLD.jsonl --rebuilt NEW.jsonl --view VIEW.json` | Fails when the rebuilt prefix differs from the writer's render of the canonical session view, or when its retained conversation is not the source's conversation suffix |
| `helpers/read-seam-view.mjs` | `node helpers/read-seam-view.mjs --cc-lhc-home DIR --rebuilt NEW.jsonl --out VIEW.json` | Rereads the canonical session view a rebuild was rendered from, cut at its receipt |
| `helpers/probe-checks.sh` | `helpers/probe-checks.sh` | Broken-case probes for the capture and rebuilt-content checks |
| `helpers/roundtrip.mjs` | `node helpers/roundtrip.mjs <scratchDir> <outDir>` | Writes source, rebuilt and view for small cases sent through the built intake, compact, view and writer (`probe-checks.sh` cases) |
| `helpers/seed-thread.mjs` | `node helpers/seed-thread.mjs <repoRoot> <ccLhcHome> <workDir> <codeword>` | Seed precondition thread via built `lhc` SDK |
| `helpers/run-seeded-drives.sh` | `helpers/run-seeded-drives.sh` | All seeded drives timed, then cleanup |
| `helpers/cleanup.sh` | `helpers/cleanup.sh` | Remove recorded temp HOMEs; keep evidence |
| `helpers/link-check.mjs` | `node helpers/link-check.mjs` | Skill links, sections, feature H2s, helper executability |

Feature map: [features/README.md](features/README.md) indexes
[capture](features/capture.md), [rebuild](features/rebuild.md),
[Smart Compact](features/smart-compact.md), and the
[control panel](features/control-panel.md).

## Re-verification

Every seeded drive runs `packages/cc-lhc/dist/bin.js` with the staged `cc-lhc-native` addon, `packages/lhc/dist`, and the stand-in `packages/cc-lhc/test/fixtures/oneshot-claude.mjs`.

- **Reruns every drive:** a change in `packages/cc-lhc/` or `packages/cc-lhc-native/` outside `test/` and Markdown, to `oneshot-claude.mjs`, or to `helpers/lib.sh`. When the brief routes a `packages/lhc` change or a root change here (the root `package.json`, `pnpm-workspace.yaml`, the lockfile, or the Node or pnpm version `.github/workflows/pr-checks.yml` pins), rerun every drive too. A rebase onto a trunk that changed any of these counts.
- **Reruns `drive-rebuild.sh` and `drive-smart-compact.sh`:** a change to `helpers/seed-thread.mjs` or `test/fixtures/claude-2.1.226-model-fallback-sequence.jsonl`.
- **Reruns one drive:** a change to its `drive-*.sh`, to `capture-bound-claude.mjs` (`drive-capture.sh`), or to `check-rebuilt-content.mjs` or `read-seam-view.mjs` (`drive-smart-compact.sh`). Run `probe-checks.sh` too when the change touches an assertion in `drive-capture.sh` or `drive-smart-compact.sh`, `capture_ingested` in `lib.sh`, or any helper they or `probe-checks.sh` use.
- **Carries:** the rerun rules above take precedence. A change only in packages the brief does not route here, or in other `packages/cc-lhc/test/` files, carries. Markdown that is test input, such as fixtures and goldens, follows the `test/` rules. Prose-only Markdown anywhere, top-level `docs/` and this skill included, carries only when it changes no lane's setup, actions, assertions, expected outcomes, evidence or cleanup. Any path no rule here names reruns every drive. `doctor.sh` and `link-check.mjs` always rerun.
- **Carries every drive:** a change only to `.agents/verify-media/`. Those scripts make pictures and grade nothing. Run `.agents/verify-media/probes.sh` and one capture of each changed script.
