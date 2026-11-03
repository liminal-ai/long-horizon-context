# cc-lhc-mod

`cc-lhc-mod` is Long Horizon Context (LHC) for plain `claude`. It is a Claude Code mod named `lhc` and a Node sidecar that the mod starts. The mod records every row of the session into an LHC thread. When Claude Code compacts, the mod answers with the LHC view of that thread instead of Claude Code's own summary. The session id stays the same, so background shells, agents, and typed-ahead input survive every compaction.

The design and its limits are in [docs/onboard/07-host-cc-lhc-mod.md](../../docs/onboard/07-host-cc-lhc-mod.md).

## Requirements

- Claude Code 2.1.317. The mod API is early access, so run the seam check after each Claude Code update (see [Check a new Claude Code release](#check-a-new-claude-code-release)).
- Node 24.3 or later as `node` on `PATH`. The mod has no Node of its own, and it starts the sidecar with `node`.
- pnpm, and a checkout of this repository.
- The Claude Code CLI. The desktop app and the Agent SDK have no `$.process`, so they cannot start the sidecar.

## Install and run

1. Build the core, the shared adapter, and the mod from the repository root:

	```sh
	pnpm install --frozen-lockfile
	pnpm --filter lhc build && pnpm --filter claude-adapter build && pnpm --filter cc-lhc-mod build
	```

	The last line of the output is `built <repo>/packages/cc-lhc-mod/dist/plugin`.

2. Start Claude Code with the plugin, from the directory you want to work in:

	```sh
	claude --plugin-dir <repo>/packages/cc-lhc-mod/dist/plugin
	```

3. Send any prompt, then run `/lhc status`. Its first line reads `Context <tokens> of <trigger> (<pct>%), thread th_<id> (new).`

4. Run `/compact`. LHC answers it with its view, and Claude Code prints `Compacted`. The status line under the prompt box reads `⚠ lhc: <before> → <after>`, the context in tokens, until your next turn ends. If LHC cannot answer, Claude Code's own summary runs, the transcript shows `LHC could not compact (...)`, and the status line reads `⚠ lhc: fell back to Claude Code's summary` until the next LHC compaction succeeds. Claude Code adds the `⚠` to a plugin's status line.

5. Run `/lhc` to open the LHC panel. It shows the context against the trigger, the last compaction, derivation counts, and the settings. `ctrl+x x` closes it.

The plugin is not in a marketplace yet. Pass `--plugin-dir` on every launch, or define a shell alias for it.

The status line is empty the rest of the time. Claude Code's own `N% until auto-compact` counts toward the LHC trigger, so the mod shows no pressure line of its own.

## Settings

The three settings are global. They follow the live model's window, so a model change moves the trigger.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `lowerBound` | 140000 | Context left after a compaction, the target |
| `upperBound` | 800000 | Largest trigger |
| `compactPercent` | 90 | Trigger as a percentage of the window |

The mod computes the trigger and the target from the window W:

- trigger = min(`upperBound`, `compactPercent` x W, W - 33000)
- target = min(`lowerBound`, 0.4 x W, trigger / 2)

On a 1M window the defaults give an 800k trigger and a 140k target. On a 200k window they give a 167k trigger and an 80k target. Claude Code cannot compact later than W - 33000, so the panel shows a `Clamped:` line when that limit applies. Each bound is at least 10000 tokens.

To change a setting, use one of these:

- The **lhc** rows in `/config`.
- The panel's inputs.
- `/lhc bounds <lower> <upper> [percent]`, for example `/lhc bounds 100k 600k 85`.
- `--settings '{"pluginConfigs":{"lhc@inline":{"options":{"lowerBound":100000}}}}'` on the command line, for one launch.

A fourth option, `inferenceWorker`, picks where LHC's summaries run. `bridge` (the default) runs them on the session's own model client. `sdk` runs them in an Agent SDK process inside the sidecar. Set `LHC_NO_INFERENCE=1` before you start `claude` to replace both with deterministic summaries.

## Commands and tools

| Command | Does |
| --- | --- |
| `/lhc` | Opens the panel |
| `/lhc status` | Prints the panel's facts as text |
| `/lhc compact` | Compacts now with the LHC view |
| `/lhc prune` | Hides older history from the live view without a new compaction |
| `/lhc export` | Writes the thread's history to `<LHC home>/exports/<thread>-<time>.json` |
| `/lhc bounds <lower> <upper> [percent]` | Changes the settings. Numbers take `k` and `m` |

The model gets two tools, `mcp__lhc__get_turns` and `mcp__lhc__get_messages`. They read compacted history back by the `tN` and `mN` ids the view shows. They need no permission prompt.

## State

LHC keeps its state in `$LHC_HOME`, else `~/.lhc`.

| Path | Holds |
| --- | --- |
| `registry.sqlite`, `threads/` | The LHC registry and one SQLite file per thread |
| `owners/<thread>.json` | The lease that keeps one Claude process per thread |
| `cursors/<session>.json` | How far into the transcript capture has committed |
| `receipts/<session>.json` | The last installed view, so its rows are not recorded twice |
| `logs/mod-<load>.log`, `logs/sidecar-<load>.log` | One pair per mod load |
| `run/<load>.sock` | The sidecar's socket, in a mode 0700 directory |
| `exports/` | `/lhc export` output |

To read a thread from the shell, run `node packages/lhc/dist/cli.js thread export --home ~/.lhc --thread-id <thread> --out <file>`. `thread health` takes the same flags.

## Limits

- Thinking blocks and images in the live tail do not survive a compaction. An image becomes `[image omitted by LHC: m<id>]` and a document becomes `[document omitted by LHC: m<id>]`. Retrieval serves text only.
- `tool_reference` blocks from ToolSearch are dropped from the view.
- LHC cannot split one model step. If the tool results of a single step, such as six parallel 10k reads, plus the fixed context do not fit under the trigger, LHC refuses its view. Claude Code's own summary then runs once, with the `LHC could not compact (...)` notice and the `⚠ lhc: fell back to Claude Code's summary` line. That costs about 14 s of API time and about 70k cache-write tokens. It happens only when a step is large compared with the trigger, such as a 60k test trigger, and not at the default 800k.
- On a 200k window the trigger is at most 167k, whatever the settings say.
- Claude Code has no rewind event. The sidecar finds a rewind from the transcript at the next prompt.
- If Claude Code exits in the middle of a tool call, its transcript can leave out that call and its result. The LHC thread keeps them, so it holds one call more than the transcript.
- `/compact <instructions>` records the instructions as a note. LHC does not summarize by instruction.
- A thread an older host wrote with forced compact boundaries is not adopted. The session starts a new thread and shows a notice that names both.
- Each open session runs its own sidecar of about 250 to 360 MiB.

The full list, with what each limit means for you, is in [doc 07](../../docs/onboard/07-host-cc-lhc-mod.md#limits).

## Check a new Claude Code release

Run the seam check after every Claude Code update:

```sh
pnpm --filter cc-lhc-mod seam-check
```

It prints `claude --version` and ends with `seam-check: PASS` when every seam the mod depends on still holds. Run `pnpm --filter cc-lhc-mod test` for the unit tests.

## Diagnose a problem

- `<LHC home>/logs/mod-<load>.log` has one line per bind, settings change, and compaction.
- `<LHC home>/logs/sidecar-<load>.log` has `bound session <id> ...`, the capture lines, and the compaction lines.
- `claude --debug-file <file>` adds Claude Code's own log, where the mod's lines start with `[lhc]`.
- `curl --unix-socket <LHC home>/run/<load>.sock http://x/health` prints the binding and the thread the sidecar records into.
