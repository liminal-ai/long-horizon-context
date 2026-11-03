---
name: verify-cc-lhc-mod
description: "Verify cc-lhc-mod (packages/cc-lhc-mod, the Claude Code mod plus per-process Node sidecar for LHC) the way a user runs it: plain claude with --plugin-dir in an isolated tmux session, a throwaway LHC home and a pinned Claude Code version. Use when proving the mod's sidecar, session binding, settings and compact trigger, reload, capture into the LHC thread (rows, recovery, lease, rewind), compaction answered with the LHC view (mid-turn, manual, fallback, resume, install receipts), get_turns and get_messages retrieval, or the seam check on a new Claude Code release."
---

# Verify cc-lhc-mod

Surface: the `lhc` mod in `packages/cc-lhc-mod`. A person runs plain `claude`
with the plugin loaded. The mod (`mod/hooks/register.ts`, bundled to
`dist/plugin/hooks/register.js`) runs inside Claude Code with no Node. On load
it spawns one Node 24 sidecar (`sidecar/src/`, bundled to
`dist/plugin/sidecar/main.js`) and talks to it over a Unix socket. The user
touches the Claude Code UI, `/config` rows for the mod's three settings, and
(later PRs) the LHC panel and commands.

Facts from the code. Read them before driving:

- LHC home is `$LHC_HOME`, else `~/.lhc` (`lhcHome` in `mod/hooks/register.ts`).
  Every drive sets `LHC_HOME` to a throwaway dir. Never point it at a real home.
- Layout under the LHC home (`src/paths.ts`): `run/<load id>.sock` in a mode
  0700 directory, `logs/mod-<load id>.log` and `logs/sidecar-<load id>.log`.
  One load id per module load, so a hot reload starts a new pair. Capture
  adds `registry.sqlite` and `threads/` (core), `owners/<thread id>.json` (the
  lease, holding the Claude process pid) and `cursors/<session id>.json` (the
  committed transcript offset). `forks/<session id>` marks a refused fork,
  which stays refused across a sidecar restart and a reload. Compaction adds
  `receipts/<session id>.json`, the last install receipt.
- Capture (`mod/hooks/capture.ts`, `mod/hooks/sidecar.ts`,
  `sidecar/src/capture/`): the mod puts every main-loop `session.append` row,
  `turn.start`, `turn.step`, `turn.complete` and every bind in one ordered
  outbox. A flush sends entries in order, executes a bind itself as a barrier,
  and drops an entry only when the sidecar answers after the commit. A
  replacement sidecar is replayed the last sent bind before any row; a failed
  send retries with backoff, and after 5 failures in a row capture stops with
  one notice in the transcript. The sidecar sets its binding only once the
  recording opens, and refuses entries for another session or with no
  recording open. It records into
  the thread under alias `claude-code:<session id>`, dropping `queue` and
  `notice` rows, rows with no role, rows an install receipt claims, and mechanical
  attachments by name (`MECHANICAL_ATTACHMENTS` in
  `sidecar/src/capture/map.ts`). A row whose origin is `task-notification`
  (live: the `session.append` origin; recovered: the attachment's origin or
  command mode) is a `runtime_note` holding its `<task-notification>` element;
  any other `queued_command` is the person's steer. Claude Code's own
  compaction summary (a `compaction` row live, an `isCompactSummary` row in
  the transcript) is a `runtime_note` starting `[Claude Code compaction
  summary: LHC fell back to native compaction]`.
- Recovery and rewind: at each bind the sidecar records transcript rows past
  the committed cursor through the same path as live rows, making the
  decisions live capture makes: a user text row is the person's prompt
  (typed, `claude -p`, or an old row with no `origin`), the native `/compact`
  line is a note, and the command rows a native compaction writes after its
  summary, which no hook sees, are dropped; the summary itself is recorded
  as one labeled `runtime_note`, as live capture labels it. A recovered user
  row with neither `origin` nor `promptSource` is unmarked: an old-version
  prompt, or a row of an installed LHC view, which in `claude -p` carries no
  other mark. The install receipt alone decides it: a match is claimed and
  opens no turn; anything else is a prompt. A typed or `-p` prompt is never
  claimed. A slash command is recorded once as
  `/name args`: a built-in local command (`/clear`, `/model`), which
  Claude Code files right after a `<local-command-caveat>` row, is a
  `runtime_note`; any other command (a skill, a plugin or custom command,
  typed or by `claude -p`) prompts the model and is a `user_prompt` that
  starts a turn. Its caveat, its output and the
  hidden expanded body that follows a prompt command (a skill's or a custom
  command's) are dropped, live and recovered. A rollback never keeps a row past
  the first abandoned one. Recovery also restores the turn state the
  transcript shows: a prompt opens a turn, each model response (one message
  id) is a step with its tool results, and a turn's duration row settles it,
  so a sidecar reloaded mid-turn knows the turn is open and keeps live step
  indices. A branch off the
  transcript's active chain (from its last row by parent) that holds a
  person's prompt is abandoned: recovery never records it, and a new prompt
  whose path back to the nearest recorded row passes one writes core
  `rollback`. A branch without a prompt (parallel tool calls) is live. A
  rewind reaches back to a compact boundary but not past it. A fork is refused for the session's life
  (`forks/<session id>`).
- Lease: a second live Claude process on the same thread is refused with a
  notice in the transcript. The lease outlives a sidecar that exits under a
  live Claude process (a reload, a kill); a dead owner's lease is taken over
  at the next bind. `LHC_NO_INFERENCE=1` in the pane's env swaps the Agent SDK
  summary worker for deterministic derivations.
- Capture limits, accepted for v2. A row live capture missed and recovery
  later records lands at the end of the record, not in its place; a rewind
  found only by recovery also hides rows recorded live after it. A refused
  second session still writes to the shared transcript, so the owner's next
  recovery records its rows.
- Binding: `classic.SessionStart` (startup, clear, resume, fork, and
  `compact` after each compaction) posts `/bind`. A reload re-runs `session.start` only, so the mod keeps the binding
  in `$.state` and rebinds with source `reload`. The sidecar answers
  `GET /health` with its binding and policy.
- Settings (`src/settings.ts`): `userConfig` fields `lowerBound` (140000),
  `upperBound` (800000), `compactPercent` (90). The window is the compact
  window (`breakdown.rawMaxTokens`, which `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  changes), else the model window. Trigger `min(upperBound, percent x window,
  window - 33000)`, target `min(lowerBound, 0.4 x window, trigger / 2)`, so the
  target is always below the trigger and a lowered percent always holds. The mod sets
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to `100 x trigger / (window - 20000)`, nudged
  up by tiny relative float steps until the engine's floor of it equals the
  trigger (on 200k it logs `92.77777777777779`, not `92.77777777777777`).
- Compaction (`mod/hooks/compact.ts`, `sidecar/src/compact.ts`,
  `projector.ts`, `receipts.ts`): every main-loop `session.compact` (`auto`,
  `manual`, `plugin`) drains the outbox, then posts `/compact` with the
  applied target. The sidecar runs recovery, calls core `midTurnCompact` when
  a turn is open or `compact` when settled, projects the session view into
  built `SessionMessage`s (no `handle`, no thinking; images and empty tool
  results become `[image omitted by LHC: m<id>]` and `[empty tool result:
  m<id>]`; a call the view never answers gets an error result), and persists
  the receipt before it answers: one
  fingerprint per message (`role:` plus tool ids, or a text hash). Claude Code
  appends the install back one row per message (user text by door `note`,
  assistant by `response`, results by `tool-result`); live capture and
  recovery claim them in order and record none. For an interactive manual
  `/compact`, Claude Code writes the installed rows to the transcript but
  raises them through `session.append` only after the next prompt's row, or
  not at all; in that case the next bind's recovery claims them by receipt. `precompute` is
  skipped and subagent compactions pass through. `/compact <text>` records a
  `[/compact instructions, recorded only: ...]` note and a transcript notice.
  A view that cannot help is not installed: when the view's tokens plus the
  fixed context (the engine breakdown's `used` rows other than `Messages`,
  logged as `fixed context N`, sent with `/compact`) reach the trigger, the
  sidecar answers native before it begins a receipt, so a receipt only ever
  exists for an installed view, and the hook falls back as below.
  Any failure (sidecar unreachable, outbox not drained, core refusal) logs
  `compact <trigger> fell back to native after <ms>ms: <reason>`, shows `LHC could not
  compact (...)`, sets the status line to the fallback, and returns
  `next(e)`. The native summary is recorded as one labeled `runtime_note`:
  live when Claude Code raises it (an auto or `claude -p` compaction), and by
  the next bind's recovery when it does not (an interactive manual one).
  A killed sidecar is respawned on the next post and rebinds with source
  `restart`, so it answers the next compaction itself.
- Status line and pressure: a view sets `LHC compacted <before> to <view>
  (mid-turn|settled)`. At the next main-loop step the mod reads the engine's
  own estimate (`breakdown.totalTokens`) and logs `post-compact context N
  trigger T target X ok|inadequate`; above 75 percent of the trigger it also
  shows a transcript notice, since Claude Code stops a turn after three
  refills within three turns.
- Retrieval (`mod/hooks/retrieval.ts`, the sidecar's `/retrieve` route):
  `mcp__lhc__get_turns` and `mcp__lhc__get_messages` are registered at
  `session.start` in the prompt's tool list and answered by a `tool.call`
  hook, so no permission prompt shows in any mode. The sidecar serves them
  with claude-adapter's budgets (8000 tokens, 48000 bytes, 32 ids) and the
  `<recalled-history>` envelope; impressions go to core under surface
  `claude-code:<op>`. A failure reaches the model as the tool's error text.
- Claude Code reads the plugin's options from settings `pluginConfigs`
  under `lhc@inline` for a `--plugin-dir` load. A drive passes them with
  `--settings '{"pluginConfigs":{"lhc@inline":{"options":{...}}}}'`.
- Auth: drives run the real `claude` with the operator's own login or env
  auth, from a throwaway work dir. `HOME` stays real because the login lives
  there. So never run `/model` or `/config` in a drive that uses the real
  Claude home: they write `~/.claude/settings.json`. Pick the model with
  `--model`, and check a built-in local command with `/clear`.
  Transcripts land in `~/.claude/projects/<encoded work dir>/`.

## Launch

Build from the repo root:

```sh
pnpm install --frozen-lockfile
pnpm --filter lhc build && pnpm --filter claude-adapter build && pnpm --filter cc-lhc-mod build
claude --version   # record it; every drive pins it with DISABLE_AUTOUPDATER=1
```

Launch one interactive session:

```sh
.agents/skills/verify-cc-lhc-mod/helpers/launch.sh <tmux session> [home] [-- claude args...]
```

It makes a throwaway home (`h-XXXX` under the scratch root) unless you pass
one, starts `claude --plugin-dir packages/cc-lhc-mod/dist/plugin --debug-file
<home>/debug-<session>.log` in a detached tmux session with
`DISABLE_AUTOUPDATER=1` and `LHC_HOME=<home>/lhc`, accepts the folder-trust
dialog, and waits for the sidecar's bind. Ready is the printed `HOME=<path>`
and `bound session <id> transcript <path> source startup`. Extra env for the
pane goes in `VERIFY_ENV`, for example
`VERIFY_ENV="CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000"`. Name sessions for the
lane, such as `ccv2-lane-<pr>-<n>`.

## Doctor

```sh
.agents/skills/verify-cc-lhc-mod/helpers/doctor.sh
```

Read-only. Checks Node 24, tmux, `claude`, the built plugin, `claude plugin
validate`, and that the scratch root sits outside any repo. Pass line:
`VERIFY-CC-LHC-MOD doctor: PASS`.

## Drive

| Helper | Does |
| --- | --- |
| `helpers/say.sh <session> <text>` | Types a prompt or slash command and presses Enter |
| `helpers/wait.sh <home> <regex> [timeout]` | Waits for a line in the home's mod, sidecar or debug logs |
| `helpers/stop.sh <session> [pane file]` | Saves the pane, sends `/exit`, kills that exact tmux session |
| `helpers/perf.sh [runs]` | Interleaved launches with and without the plugin, launch-to-prompt-box time and sidecar RSS |
| `helpers/compare.mjs <export.json> <transcript.jsonl>` | Diffs a thread export against the transcript's live branch: prompts, tool calls, tool results, assistant text. Rows an LHC install appends after a boundary (labeled bands and notes, messages already seen) are skipped. So are Claude Code's own `<synthetic>` messages, such as the refill breaker's, which capture never records. Pass line `compare: PASS` |
| `helpers/synth-transcript.mjs <work dir> <turns> [lines]` | Writes a resumable Claude Code transcript for `<work dir>` (one Read per turn, about 3.9k tokens each; 77 turns is about 300k) and prints its session id, for the compaction cost drive |
| `helpers/fixtures.sh <home>` | Writes the compaction drives' inputs into `<home>/work`: `f1.txt` to `f6.txt` (about 8k tokens each, last line `last word: whiskey`, `echo`, `romeo`, `xray`, `tango`, `kilo`) and `pic.png`, a red square |
| `helpers/capture-perf.sh [runs]` | The same headless 40-call session with and without the plugin, interleaved: wall time, the append hook's p95 own time, commit lag p95 |
| `helpers/cleanup.sh` | Kills the tmux sessions the helpers recorded, removes recorded homes |

Seam check, headless, run on every Claude Code release:

```sh
pnpm --filter cc-lhc-mod seam-check
```

It builds, prints `claude --version`, and runs `claude -p` four times against
the built mod. Each seam observes what its name says:

- `validate`: `claude plugin validate` exits 0.
- `bind-startup`, `bind-transcript`, `bind-resume`: the sidecar logs the
  session id, its existing `<id>.jsonl` transcript, and the source.
- `socket-dir`: the socket directory is mode 0700.
- `sidecar-exit`: the sidecar's PID is gone within 5 s of `claude` exiting.
- `mod-computes-policy`: the mod's logged policy for the live window equals
  the settings model's. This checks the mod's arithmetic only. The override
  seams prove the engine side.
- `settings-from-userConfig`: `--settings` options reach the mod: window
  100000, trigger 30000, target 10000, pct 37.5.
- `output-reserve`: a 100k window gives exactly `effectiveWindow=80000`.
- `override-lowers-trigger`: a real crossing at trigger 30000. The first auto
  `compact_boundary` row's `compactMetadata.preTokens`, the engine's own count
  of what it compacted, is at or above 30000 and below the 67000 default, and
  the run's first autocompact check is `ok` or `warn`, so a threshold below
  the starting context fails. It catches an override that is missing, below
  the starting context, or at the default. It does not catch a threshold a
  few thousand tokens off the trigger: an early compact attempt can bail and
  the debug log redacts check counts (24000 against a 30000 trigger passed).
  Request usage is not used: it predates the tool result the next check sees.
- `dispatch-at-trigger-text`: in the same crossing run, whose steps are
  text Reads, the mod's own measure of context at the first auto
  `session.compact` dispatch is at or above the trigger, and its measure at
  the step before is below it. The measure is the last main-loop response's
  usage plus Claude Code 2.1.317's estimate of the content appended since
  (`src/estimate.ts`, unit-tested against the engine's values, images at
  2000 included). The mod log line is `compact auto dispatch context M last
  check P trigger T`. This catches a threshold more than about one step below
  the trigger, which the redacted debug log cannot. It proves text only: an
  image counts 2000 only until the next response replaces the estimate, so
  no live crossing rests on it. The measure also runs low by what Claude
  Code adds without a `session.append` carrying it (reminder text an
  attachment row holds empty); a headless six-file run measured 55925 at an
  engine dispatch against a 60000 trigger. Read a shortfall like that as the
  measure's, not the engine's.
- `override-default-holds`: with the defaults (trigger 67000), no check in
  the run is compact-level.

Pass line: `seam-check: PASS`.
It removes its scratch dir on a pass and keeps it, with the debug logs, on a fail.
Interactive seams (`/clear`, reload, a real crossing) are the drives below.
Unverified anywhere: the live re-apply after `/model`. There is no seam for
it and no drive has run it, so report it as unverified, not passed.

Unit checks: `pnpm --filter cc-lhc-mod test` (settings, sidecar, capture, recovery, rewind, projector, receipts, the compact route, retrieval). CI runs it.

Local-only checks. CI has no Claude Code, so its typecheck logs `SKIP mod
type-check and claude plugin test` and runs neither. Run both locally before
every code-ready or fix-round push:

```sh
helpers/launch.sh <session> && helpers/stop.sh <session>   # Claude Code lays dist/plugin/.claude-plugin/types
pnpm --filter cc-lhc-mod typecheck   # expect "mod typecheck against .../claude-code/index.d.ts", not SKIP
pnpm --filter cc-lhc-mod test:mod    # test/mod.test.ts under claude plugin test dist/plugin
```

The build keeps `dist/plugin/.claude-plugin/types`, so one launch per Claude
Code version is enough. `CLAUDE_CODE_TYPES=<path to claude-code.d.ts>` points
the type-check at another copy, such as the one the plugin-authoring skill
writes. The repo does not vendor that early-access file.

Feature drives are in [features/README.md](features/README.md).

## Evidence

Evidence dir is `$VERIFY_EVIDENCE`, one folder per run, because the machine
is shared: its `tmux.txt` and `homes.txt` are the only things `cleanup.sh`
may kill or delete. Set it once at the start of a run and export it, for
example `export VERIFY_EVIDENCE=$(mktemp -d <main checkout>/.pstack/runs/verify-cc-lhc-mod/run-XXXX)`.
Unset, each helper makes a fresh `run-<time>-XXXX` folder under
`.pstack/runs/verify-cc-lhc-mod` in the main checkout (the first entry of
`git worktree list`) and prints the line to export. Throwaway homes go under `$VERIFY_SCRATCH_ROOT`,
default `${XDG_STATE_HOME:-~/.local/state}/verify-cc-lhc-mod/scratch`. The
path stays short because the socket path must fit in 107 bytes, and outside
any repo because Claude loads each `CLAUDE.md` above its work dir.

Read-only diagnostics, per home:

- Mod log: `<home>/lhc/logs/mod-<load id>.log`. Binds, and one line per
  settings apply: `<reason> window W trigger T target X pct P [clamped]`. The
  same lines go to the debug log as `[lhc] $.ui.log (to debug): ...`.
- Sidecar log: `<home>/lhc/logs/sidecar-<load id>.log`. `listening`,
  `bound session <id> transcript <path> source <source>`, `policy ...`,
  `exit <signal>`.
- Debug log: `<home>/debug-<session>.log`. `autocompact: ... level=ok|warn|compact
  effectiveWindow=E` per check, plugin load and reload lines.
- Health: `curl --unix-socket <home>/lhc/run/<id>.sock http://x/health`,
  with `recording` naming the thread or the refusal.
- Capture lines. Sidecar: `recording session <id> thread <thread> recovered
  R of N transcript rows`, `captured E entries recorded M events lag Lms`,
  `rewind before prompt <uuid>: rollback keeps through event K`, `not
  recording: <notice>`. Mod: `capture hook rows N p95 Xms max Yms` per turn.
- Compaction lines. Sidecar: `compact <trigger> mid-turn|settled view V
  tokens (target X) messages M compact point P degraded D gaps G recovered R
  took Tms`, `compact <trigger> answered native: <reason>`, `<op> <ids>
  served N chars`. Mod: `compact <trigger> mid-turn|settled view V messages
  M`, `compact <trigger> fell back to native after <ms>ms: <reason>`, `post-compact context
  ...`, `<op> [ids] answered N chars`. The receipt: `jq '.claimed | length'
  <home>/lhc/receipts/<id>.json` equals `.expected | length` once installed.
- Debug log: `[API REQUEST] /v1/messages source=compact` is Claude Code's own
  summary request; an LHC answer makes none.
- The thread: `node packages/lhc/dist/cli.js thread export --home <home>/lhc
  --thread-id <thread> --out <file>` and `thread health` with the same flags.
- Transcript JSONL at the path the bind line names. `compact_boundary` rows
  carry `preTokens`.

Save the pane (`stop.sh <session> <file>`) and copy the logs a verdict cites
into the evidence dir before cleanup.

## Cleanup

```sh
VERIFY_EVIDENCE=<your run's folder> .agents/skills/verify-cc-lhc-mod/helpers/cleanup.sh
```

It refuses to run without `VERIFY_EVIDENCE`, so it never touches another
run's sessions or homes. Never kill by a name pattern, and never point
`VERIFY_EVIDENCE` at a folder another run uses.

It kills only the tmux sessions the helpers recorded in `tmux.txt`, by exact
name, and removes only `h-*` homes under the scratch root recorded in
`homes.txt`. A session you started by hand is yours to kill by its name.
Never kill a `claude` or `node` process by pattern. Transcripts under
`~/.claude/projects/` stay; list the session ids you made in your report.

## Re-verification

- Reruns every drive and the seam check: a change under `packages/cc-lhc-mod/`
  outside `test/` and Markdown, a Claude Code version change, or a change to
  `helpers/lib.sh` or `helpers/launch.sh`.
- Reruns the perf drive: a change to the mod's `session.start` or
  `classic.SessionStart` hooks, the sidecar's startup, or `helpers/perf.sh`.
- Reruns the compaction and retrieval drives: a change to
  `mod/hooks/compact.ts`, `mod/hooks/retrieval.ts`, `sidecar/src/compact.ts`,
  `projector.ts`, `receipts.ts`, or the `/compact` and `/retrieve` routes.
- Reruns the capture perf drive: a change to `mod/hooks/capture.ts`,
  `sidecar/src/capture/`, the sidecar's `/capture` route, or
  `helpers/capture-perf.sh`.
- Carries: text in this skill and `features/` that changes no setup, action,
  assertion or evidence. `doctor.sh` always reruns.
