# Running `claude -p` as a plain one-shot text call

How to make `claude -p` (or the Agent SDK) behave like a plain model call: your system prompt, your input, one text reply, and none of Claude Code's coding-agent setup. Used for LHC's background summary workers (smoothing, turn and chunk summaries).

## Why

By default every `claude -p` request carries Claude Code's framing on top of your prompt:

| Piece | Comes from |
|---|---|
| Claude Code's own system prompt | built in |
| Tool definitions (~34k tokens) | built in, plus configured tool servers |
| The user's output style (e.g. "You are an interactive CLI tool that helps users with software engineering tasks…") | user settings |
| Hooks output, skills list, agent types, attribution reminder | user settings |
| The project's CLAUDE.md / AGENTS.md, framed "OVERRIDE… MUST follow" | the working folder |
| Working folder, platform, model name, date (~500 chars) | built in, always added |

For a summary worker that framing tells the model it's a coding agent. Measured on 2026-09-24 (Claude Code 2.1.281, Sonnet, 12 runs per cell, smoothing and turn-compression over six inputs, instruction-heavy turns included):

| | Tools on | Tools off |
|---|---|---|
| Framing present | 72/72 | 66/72 and 68/72 (two rounds) |
| Framing removed | 72/72 | **72/72** |

With framing present and tools off, the model summarized the environment block, claimed it had done the task ("Done: …"), or said there was no content. The long tool list only masked that. `--max-turns 1` and `--strict-mcp-config` caused no failures by themselves. Removing the framing cut a call from ~39k to ~2.7k input tokens. Evidence: `~/.local/state/lhc-campaigns/claude-lhc-get-turns-20260924/isolation/` (REPORT.md, REPORT-2x2.md, request captures).

## The command

```sh
cd "$(mktemp -d)"          # empty folder: no CLAUDE.md / AGENTS.md
claude -p \
  --system-prompt-file prompt.txt \
  --setting-sources "" \
  --tools "" \
  --strict-mcp-config \
  --max-turns 1 \
  --no-session-persistence \
  --model sonnet \
  < request.txt
```

| Flag | Removes |
|---|---|
| empty working folder | project CLAUDE.md / AGENTS.md and project settings |
| `--system-prompt-file` / `--system-prompt "…"` | Claude Code's system prompt (replaced, not appended; `--append-system-prompt` would append) |
| `--setting-sources ""` | all settings files: output style, hooks, skills, tool servers, env from settings |
| `--tools ""` | built-in tools |
| `--strict-mcp-config` (with no `--mcp-config`) | all tool servers |
| `--max-turns 1` | follow-up turns |
| `--no-session-persistence` | the session file |

Not affected by these flags: `--safe-mode` alone still loads user settings, so it doesn't do this job. What remains after the template is only the working folder, platform, model name and date.

Check: add `--output-format json`; `usage.input_tokens` (plus cache fields) should be around 2–3k, not ~39k.

## Login caveat

`--setting-sources ""` also drops anything that lives only in the settings file's `env`, including an API key or base URL kept there. A normal `claude` login and keys in environment variables still work. Hosts using this must keep auth working when settings aren't loaded (pass through only the auth-related env keys if needed).

## Agent SDK equivalent

The same controls are query() options: a string `systemPrompt` (replaces the preset), `settingSources: []`, no tools, `mcpServers: {}`, `maxTurns: 1`, no session persistence, and an empty `cwd`. Check the defaults on the pinned SDK version before relying on them. claude-lhc uses the SDK for its summary calls from 0.1.1; cc-lhc uses the flags above from 0.4.5.
