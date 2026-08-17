# Claude Code 2.1.233 bounded compatibility evidence (LIM-80 Slice 4)

Read-only revalidation of cc-lhc against the installed Claude Code binary. No runtime
version gate is added; this file records the bounded evidence behind the "revalidated
against 2.1.233" support comments in `src/intake/argv.ts`, `src/intake/launch-session.ts`,
and `src/intake/map.ts`.

## Installed binary

- Resolved path: `/home/leemoore/.local/bin/claude` → `/home/leemoore/.local/share/claude/versions/2.1.233`
- `claude --version` → `2.1.233 (Claude Code)`
- Other installed versions present: 2.1.228, 2.1.232 (not used here).

## Help surface (argv arity inventory)

- Captured option-token census: `claude-2.1.233-help-options.txt` (62 options).
  - `sha256(claude-2.1.233-help-options.txt)` = `87ee3188abd274ce9cfb5856f18b75826f0054bceb0347e9cb985a0332e8d30e`
  - `sha256(claude --help | full text, piped/80-col)` = `71ad650f59e08ae40ede14c534db4f49d8590ee5a4f92f6da2882d3a5560fea6`
- `--autocompact` documented value grammar in 2.1.233: `--autocompact <auto|tokens>` = "auto, or
  100k–1M tokens" — matches the Slice-4 classifier (`src/intake/argv.ts`).
- Arity tables in `launch-session.ts` are consistent with 2.1.233. Notable points:
  - `--background`/`--bg` (zero-arity), `--environment <id>` (one-value), `--no-session-persistence`
    (zero-arity) are present in 2.1.233 and are now refused for capture-enabled launches
    (`UNSUPPORTED_SESSION_CHANGING_FLAGS`) because they break local durable attribution/topology.
  - `--fork-session` retains its dedicated launch-grammar refusal.
  - `--append-system-prompt-file` is NOT listed in 2.1.233 `--help`; retained in the one-value set
    for older-binary tolerance (an absent flag never appears in a real launch).

## Rollout surface (record shapes)

Derived from a **disposable real 2.1.233 local session** (an `echo cc-lhc-fixture-ok` Bash
tool-call → result exchange). The bounded fixture `claude-2.1.233-tool-call-sequence.jsonl`
normalizes volatile/sensitive fields (uuids, session id, timestamps, cwd, git branch, prompt
ids, attachment bodies) to deterministic, non-sensitive values; the record SHAPES and the
top-level/content/usage censuses below are the real 2.1.233 shapes.

- LF-normalized `sha256(claude-2.1.233-tool-call-sequence.jsonl)` = `22bc540269bcb6555e80565c662bed3f6c2bc263198b403e3dabfe42adf42b95`
- Top-level `type` census: `ai-title, queue-operation, user, attachment, assistant, last-prompt`
  — all recognized (conversational or `META_LINE_TYPES`); **zero unknown drift**.
- Assistant content-block census: `thinking, tool_use, text` (+ `tool_result` on the user turn).
- Assistant `usage` key census: `input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
  output_tokens, cache_creation, inference_geo, iterations, output_tokens_details, server_tool_use,
  service_tier, speed`. `iterations` remains an array, and split thinking/tool-use records preserve
  their shared provider message ID and request ID. The provider triad (`input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens`) is read; the new 2.1.233 diagnostic keys are ignored (no double-count) —
  covered by `test/intake/map.test.ts` and `test/governor/provider-context.test.ts`.

## Commands run

```
claude --version
claude --help                                  # option census + hashes
cd /tmp/cc-lhc-233-fix3 && git init
claude -p --model sonnet --permission-mode bypassPermissions \
  "Use the Bash tool to run exactly: echo cc-lhc-fixture-ok . Then reply with just the word DONE."
# → produced ~/.claude/projects/-tmp-cc-lhc-233-fix3/<uuid>.jsonl (real 2.1.233 rollout)
```

## Limitations

- **No native-summary evidence for 2.1.233.** The disposable session did not trigger a native
  `type:"summary"` compaction, so no 2.1.233 native-summary observation is claimed here. The
  `type:"summary"` → `native_compact_observed` path remains covered by unit/fold tests only.
- The bounded fixture's CONTENT is normalized/synthetic (non-sensitive, deterministic); its record
  SHAPES/censuses are from the real 2.1.233 session.
- The full-help sha256 is terminal-width dependent (captured piped, ~80 columns); the option-token
  census hash is width-independent and is the stable arity anchor.
- No runtime child-version detection or supported-range gate is added (out of scope).
