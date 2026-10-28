# Host: claude-lhc

Last verified against code: 2026-10-27, package version 0.1.1. Precedence when facts disagree: code, then the package README (`packages/claude-lhc/README.md`), then this document.

This document builds on the vocabulary in [01-core-concepts.md](01-core-concepts.md) and [02-domain-design.md](02-domain-design.md). Record, event, derivation, view, band, and retrieval keep their SDK meanings here.

## Host position

`claude-lhc` (`packages/claude-lhc`) is a sidecar process, not a wrapper a person runs. t3code's Claude LHC provider spawns it. It runs the Claude Agent SDK (pinned `@anthropic-ai/claude-agent-sdk` 0.3.170) against the Claude Code binary t3code points it at, records every native message into an LHC thread as the primary record, and forwards the raw SDK stream to the t3code driver unchanged.

The native Claude session is a projection of the LHC served view. Every restart and every compact writes a fresh native session file from that view, under a fresh session id, and resumes it. The native session file is never the record. The LHC thread is.

This host differs from [cc-lhc](05-host-cc-lhc.md) in position. cc-lhc owns the `claude` CLI under a PTY and reads its rollout file. claude-lhc drives the Agent SDK in-process, so it sees the SDK message stream directly and can compact inside an open turn. The registry host name is `t3code-lhc` for both this sidecar's threads and their aliases (see State).

## Launch

t3code spawns the sidecar as `process.execPath` running the compiled entry, `dist/sidecar.js`. It never spawns the `bin/claude-lhc` shell wrapper. That wrapper exists for humans on PATH.

From source, build the core first, then the sidecar (`dist/` is not in git):

```sh
pnpm --filter lhc build && pnpm --filter claude-lhc build
node packages/claude-lhc/dist/sidecar.js
```

From npm, t3code-lhc installs the published package and points t3code at the entry:

```sh
npm install claude-lhc@0.1.1
CLAUDE_LHC_SIDECAR=<prefix>/node_modules/claude-lhc/dist/sidecar.js
```

Node 24.3 or later. The package bundles the `lhc` core. The core is not published separately. The sidecar reads frames from stdin until stdin closes, then it closes the session and exits 0. SIGTERM exits 0. A crash sends an `error` frame and exits 1. Diagnostics go to stderr with a `[claude-lhc]` prefix. Frames are handled strictly in arrival order.

## Wire contract

One JSON object per line on stdin (driver to sidecar) and stdout (sidecar to driver). The types live in `src/protocol.ts`.

Driver frames:

- `start` — the SDK options with non-serialisable members removed, plus an optional sidecar-only `lhc` block that never reaches the SDK.
- `user` — one SDK user message.
- `req` — a query control: `setModel`, `setPermissionMode`, `setMaxThinkingTokens`, or `interrupt`, with an id the sidecar answers.
- `res` — the driver's answer to a sidecar request.
- `abort` — reserved. The sidecar currently ignores incoming abort frames; it cancels its own requests through their AbortSignal and sends its own `abort` frame instead.

Sidecar frames:

- `msg` — one native SDK message, forwarded unchanged.
- `req` — an adapter callback that cannot cross a process boundary: `canUseTool` or `onUserDialog`.
- `res` — the sidecar's answer to a driver control.
- `abort` — the sidecar withdrew a request (its AbortSignal fired).
- `error` — unrecoverable. The sidecar stops after sending it.

Capture precedes publication. Every native message is recorded into LHC before it is forwarded as `msg`. Every prompt is recorded at the moment the SDK pulls it, which is the model-visible seam. Blank lines are ignored. An unparseable line is logged to stderr and dropped; it does not kill the sidecar.

The child Claude session runs with the operator's own Claude home and login (`CLAUDE_CONFIG_DIR`, else `~/.claude`). The sidecar sets `DISABLE_AUTO_COMPACT=1` on the child environment. Native auto-compact never runs under this host.

## Capture and generations

`src/capture/mapper.ts` maps SDK messages to LHC intake events, using cc-lhc's rules on the wire shapes. Idempotency keys are content-stable, so re-delivery records nothing twice.

One t3code thread is one LHC thread and a succession of Agent SDK generations. Exactly one generation is live. Prompts go only to the live generation, and forwarded messages come only from it. Generations change in two cases. Both project the LHC served view into a native session file under the effective Claude home (`projects/<key>/<uuid>.jsonl`, written by `src/nativeSessionFile.ts`), then resume by UUID:

- **Restart**: `start` with `resume` naming any alias of the thread.
- **Compact**: manual (`/compact` prompt) or automatic (below). `threadView.compact` installs the view, a continuation marker starts the next turn, and the old generation closes once the new one exists.

Long native turns are folded into canonical turns at safe points (`src/capture/segment-fold.ts`). Claude runs one native turn as many wire messages. Once the open canonical turn's estimate reaches the segment threshold (half the full share of the view target), the sidecar closes the canonical turn with an ordinary `turn_end` after a tool result that leaves no tool call outstanding. The native turn is untouched. Only the canonical bookkeeping moves, so later serving can split the run.

Projection replays the tail's thinking blocks with their signatures (`SELECTED_THINKING_REBUILD_ARM = "signed_verbatim"` in `src/projection/project.ts`). The package README documents the known limit: an account that rejects signed thinking over rewritten history fails the first request after a compact with a prefix-mismatch 400. Set the arm to `omit` and rebuild for such an account. No data is lost either way.

## Compact numbers

Two numbers, both required, both in provider-billed tokens. They arrive in the forwarded settings and are stripped before the settings reach Claude:

- `autoCompactWindow` — the auto-compact trigger. When provider-reported context reaches or exceeds it, a compact is due.
- `lhcLowerBound` — the rebuilt view size, passed to `threadView.compact` as the profile lower bound. It must be below the trigger, or `start` fails naming both.

The rebuild compacts with the core `continuation` profile's band shares. The sidecar holds no built-in numbers of its own: t3code's Claude LHC instance form owns both values. Before compacting, the sidecar waits up to 45 seconds (`DERIVATION_WAIT_MS`) for queued derivations, so bands assemble from renderings rather than truncated excerpts.

A compact that falls due while a turn is open does not wait for the turn to end. The next safe tool boundary stops the live query (a PostToolUse hook returns `continue: false`, after every tool call of the current assistant message has its result). LHC closes the turn on the canonical `context_compact_continue` boundary, the view is rebuilt and projected into a new generation, and a continuation input — recorded as a runtime note, never a prompt — resumes the task there. The stopped query's own result never reaches the driver. The driver sees one turn with a `compact_boundary` in the middle and one result, from the new session. A failed mid-turn compact gets no second try before the turn ends; the turn-end path tries once more. Prompts that arrive during a compact swap are held and replayed into the new generation.

## Retrieval

The sidecar adds an in-process MCP server named `lhc` to every session (`src/retrieval.ts`). It exposes two read-only tools, `mcp__lhc__get_turns` and `mcp__lhc__get_messages`. Both are on `allowedTools` and allowed by the sidecar's own `canUseTool`, so no approval request reaches the host in any permission mode.

One call serves at most 8,000 tokens and 48,000 bytes of item text, at most 32 ids (the core caps). Served content sits inside the byte-stable `<recalled-history>` envelope, the same text pi-lhc uses. Receipts and the literal next continuation call sit outside the envelope, as live text. The tools only read. This host shipped without retrieval until 0.1.1; the release note is [`docs/releases/claude-lhc-v0.1.1.md`](../releases/claude-lhc-v0.1.1.md).

## Inference lane

The SDK instance runs in background mode, so derivations drain while the thread idles. Derivations run through the summary worker (`src/summaryWorker.ts`): one Agent SDK query per derivation, no tools, one turn, session persistence off, the core's default assignments under provider name `claude-lhc-sdk`. At most 3 derivation queries run at once. The inference timeout is 90 seconds. `T3CODE_LHC_NO_INFERENCE=1` swaps in deterministic callbacks instead — capture and serving continue, summary derivations do not run. The tokenizer family is resolved from the start-option model before the SDK instance is built (`src/token-family.ts`).

## State

LHC state lives under `~/.t3code-lhc` (override `T3CODE_LHC_HOME`), created on demand:

| Path | Purpose |
| --- | --- |
| `registry.sqlite` | LHC thread registry and the alias map (`t3code-lhc:<claude session id>` → thread; latest session is current) |
| `threads/<uuid>.sqlite` | Per-thread record, derivations, views, and impressions |

Every native Claude session id the sidecar has run for a thread is an alias of that thread. A restart can name any of them. The native session files themselves live in the effective Claude home (`CLAUDE_CONFIG_DIR`, else `~/.claude`), under `projects/<key>/<uuid>.jsonl`. Each native session is titled `[LHC] <thread id>`. The t3code driver sets `T3CODE_THREAD_ID` on the sidecar process. The sidecar carries it into the child environment, so `lhc-agent` in a seat resolves its sender without `--from`. Nothing else is written: no session store, no sessions index, no wrapper log. Diagnostics are the driver's stderr capture.
