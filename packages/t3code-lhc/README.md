# t3code-lhc

`t3code-lhc` is the LHC integration for [T3 Code](https://github.com/pingdotgg/t3code), a
web application for running coding agents such as Claude Code, Codex, Cursor, and Grok.
The integration captures provider conversations into durable LHC records and lets an
operator replace an oversized provider context with an LHC compacted or pruned view
without leaving the T3 Code web interface.

This directory is documentation for the integration. The working implementation currently
lives in a maintained T3 Code fork rather than in this repository.

- Working checkout: `~/code/t3code-lhc/t3code`
- Fork: <https://github.com/liminal-ai/t3code>
- Upstream: <https://github.com/pingdotgg/t3code>
- Working branch: `lhc`
- Fork host package: `packages/lhc-host` (`@t3tools/lhc-host`)
- LHC SDK source: `~/code/pi-long-horizon/liminal-context/packages/lhc`

See also:

- [Claude Code and Codex design](./claude-code-codex-lhc.md)
- [Deferred Grok and Cursor design](./grok-cursor-lhc.md)

## What T3 Code is

T3 Code is a Node.js server plus a React/Vite web application, with desktop packaging
available separately. The browser is a client of the server rather than the owner of an
agent process. The server:

- serves the web application and authenticated HTTP/WebSocket APIs;
- persists orchestration events and projections used to render threads;
- starts, resumes, interrupts, and stops provider sessions;
- normalizes provider-native events behind a provider adapter interface;
- stores provider resume cursors and runtime metadata per T3 Code thread; and
- owns the subprocess or SDK lifecycle for each provider.

The important distinction is that T3 Code's projection database renders the web UI, but
it is not generally the context sent back to the model. Each provider reconstructs model
context from its own native session state:

- Claude Code loads rollout JSONL through the Claude Agent SDK;
- Codex app-server loads rollout JSONL by Codex thread id;
- Cursor and Grok load provider-native sessions through ACP `session/load`.

That distinction determines the LHC integration. Capturing a thread into LHC is not enough
to alter what a provider sees. A compact or prune must render the LHC view back into the
provider's native session format and make T3 Code resume that new session.

## Why T3 Code is a good LHC host

Earlier LHC hosts wrapped interactive terminal applications. Changing sessions required
PTY automation: waiting for terminal quiescence, injecting commands or keystrokes, parsing
ANSI output, handling modal states, and determining whether a terminal redraw represented
success. Those mechanisms are inherently race-prone.

T3 Code already exposes programmatic provider seams:

| Provider | T3 Code interface | Resume mechanism |
| --- | --- | --- |
| Claude Code | Long-lived Claude Agent SDK query session | Persisted `resume` cursor |
| Codex | `codex app-server` JSON-RPC over stdio | `thread/resume` by thread id |
| Cursor | ACP JSON-RPC over stdio | `session/load` by session id |
| Grok | ACP JSON-RPC over stdio | `session/load` by session id |

As a result, an LHC swap is a controlled server operation:

1. verify that the thread is idle;
2. compact or prune its LHC record;
3. render the resulting view;
4. stop the live provider session;
5. write a new provider-native session;
6. atomically change the persisted resume cursor; and
7. let the next user turn resume the rebuilt context.

There is no terminal command injection, ANSI parsing, or PTY state machine in this path.

## General system design

```text
                                      T3 Code browser
                               context ring / status / actions
                                             |
                              authenticated HTTP + WebSocket
                                             |
+--------------------------------------------v-----------------------------------+
|                                T3 Code server                                 |
|                                                                                |
|  ProviderService                         /lhc HTTP routes                      |
|  - send/start/stop turns                 - status                             |
|  - unified ProviderRuntimeEvent stream   - inspect                            |
|               |                          - compact / prune                     |
|               v                                  |                            |
|       LHC capture service                        v                            |
|       - host-side prompt tap              shared swap controller              |
|       - normalized event mapper           - lineage + busy checks             |
|       - per-thread serialized intake      - LHC operation + view render       |
|       - derivation drain                   - quiesce + preflight                |
|               |                           - provider strategy + cursor flip    |
+---------------|-----------------------------------|----------------------------+
                |                                   |
                v                                   v
      ~/.t3code-lhc/ SQLite state          provider-native session store
      - registry.sqlite                    - ~/.claude/projects/...
      - t3code-lhc.sqlite                  - ~/.codex/sessions/...
      - threads/<uuid>.sqlite              - future Cursor/Grok stores
                |
                v
      LHC background derivations
      through bounded `claude -p`
```

### Three records with different responsibilities

The integration deliberately does not force one database to do every job:

1. **T3 Code orchestration state** is authoritative for UI rendering, server commands,
   provider bindings, and persisted resume cursors.
2. **The LHC thread** is the durable context-management record. It retains captured
   prompts, responses, tool calls, tool results, derivations, compaction boundaries, and
   runtime notes.
3. **The provider session** is an executable rendering of context for a specific harness.
   It is replaced during compact/prune and then continues accumulating provider-native
   turns.

The provider session may lose or abbreviate old detail while the LHC record retains it.
A swap changes the provider rendering; it does not delete the underlying LHC history.

## Capture design

The server composes one long-lived LHC SDK instance in background mode. The capture layer
attaches synchronously to `ProviderService.streamEvents`, T3 Code's unified
`ProviderRuntimeEvent` stream, and registers an observation hook at the `sendTurn` choke
point.

The two taps have separate purposes:

- the send-turn hook records the exact user prompt even when a provider does not emit a
  canonical completed user-message item;
- the normalized provider stream records assistant messages, reasoning, tool lifecycle,
  model changes, and turn boundaries.

Each T3 Code thread maps to one LHC thread through a durable lineage database. Intake is
serialized per thread, while different threads can progress concurrently. Idempotency keys
are derived from T3 thread, turn, item, and event identities so replay or duplicate provider
signals do not double-record content.

The SDK uses a bounded one-shot inference lane adapted from `cc-lhc`: background
derivations call `claude -p`, with host-level concurrency and timeout limits. A manual mode
is available for capture without paid inference.

### Current provider status

| Provider | Capture | Compact/prune | UI actions | Status |
| --- | --- | --- | --- | --- |
| Claude Code | Implemented and live-validated | Implemented and live-validated | Enabled | Current priority |
| Codex | Implemented and live-validated | Implemented and live-validated | Enabled | Current priority |
| Cursor | Feasibility and format research complete | Not implemented | Hidden | Deferred |
| Grok | Feasibility and format research complete | Not implemented | Hidden | Deferred |

## Swap design

Claude and Codex use a shared swap controller with provider-specific strategies. The shared
controller owns the safety-critical order:

1. resolve T3-to-LHC lineage;
2. reject disabled, uncaptured, unsupported, or busy threads;
3. acquire a per-thread swap lock;
4. read and validate the persisted provider binding and resume cursor;
5. execute LHC `compact` or `prune`;
6. obtain the `SessionThreadView` to serve;
7. stop the provider session;
8. resolve the provider home and thread cwd;
9. rebuild a new native session;
10. validate the new session id and output artifact;
11. confirm that no provider session restarted during the swap;
12. write the new cursor as the last provider-state mutation;
13. read back the binding and retry once only if an idle write was stale;
14. reject a contested cursor flip rather than return false success; and
15. append an LHC runtime note and return a structured receipt.

The old cursor remains valid until the final cursor write. Failures before that point leave
future recovery on the original provider session. This flip-last invariant and explicit
contested-flip detection are central to the design.

## Control surface

The server exposes authenticated routes:

- `GET /lhc/status`
- `GET /lhc/threads/:t3ThreadId`
- `POST /lhc/threads/:t3ThreadId/compact`
- `POST /lhc/threads/:t3ThreadId/prune`

The web composer mounts an LHC popover on the existing context-window ring. For supported,
captured providers it shows LHC record size, a compact recommendation, and actions for
**Smart compact** and **Prune tool outputs**. Actions are disabled while a turn is in
flight, with server-side `409` checks as the authoritative backstop. If LHC routes are not
present, the original T3 Code context meter remains usable and the integration becomes
inert in the browser.

## State and configuration

T3 Code hosts own their LHC state. The integration intentionally does not use `~/.lhc`.

```text
~/.t3code-lhc/
  registry.sqlite
  t3code-lhc.sqlite
  threads/
    <lhc-thread-uuid>.sqlite
```

The default can be changed with `T3CODE_LHC_HOME`. Other operational controls include:

- `T3CODE_LHC_DISABLE=1` — disable the entire integration;
- `T3CODE_LHC_NO_INFERENCE=1` — capture in manual mode without `claude -p` derivations;
- `T3CODE_LHC_SUPPRESS_AUTOCOMPACT=0` — allow provider-native Claude compaction;
- `T3CODE_LHC_INFERENCE_CONCURRENCY` — bound inference subprocesses; and
- `T3CODE_LHC_INFERENCE_TIMEOUT_MS` — bound each inference call.

Native provider auto-compaction should normally be disabled when LHC owns compaction, to
avoid competing context transformations.

## Code location and fork maintenance

The implementation remains in the T3 Code fork because it needs a small number of host
integration points in server and web code. Most implementation code is isolated in the
new private package:

```text
~/code/t3code-lhc/t3code/packages/lhc-host/
```

That package links the SDK directly from this repository:

```json
"lhc": "link:../../../../pi-long-horizon/liminal-context/packages/lhc"
```

Accordingly, a deployment machine currently needs both repositories checked out in a
compatible relative layout, or the link must be adjusted.

Fork policy:

- `origin` is `liminal-ai/t3code`;
- `upstream` is `pingdotgg/t3code`;
- work is kept on the long-lived `lhc` branch;
- the fork began from upstream commit `6e42231cb1da130069cbc694f9da4a185067a81f`;
- upstream updates are merged opportunistically rather than continuously rebased;
- the running system remains pinned if an upstream change cannot be certified; and
- LHC-specific code is kept behind new modules and small marked host touch points where
  practical.

A sync-smoke command now certifies an upstream merge against real Claude and Codex CLIs.
It starts an isolated server on an ephemeral port, runs provider turns, verifies capture,
performs compact/prune, verifies recall from rebuilt sessions, tears down, writes a report,
and returns a meaningful exit code. This is intended to become the gate used by an
automated daily upstream-update job on the Linux host.

The current integration is consciously built against T3 Code's existing orchestration
layer. A future upstream orchestration architecture may change the intake and wiring seams.
The durable pieces expected to survive such a rewrite are the LHC SDK boundary, lineage
model, provider renderers, swap invariants, inference lane, operational tests, and learned
user experience.

## Known limitations

- T3 Code rollback/fork operations are not currently LHC-aware and can diverge provider
  state from the append-only LHC record.
- The per-thread swap lock does not intercept every possible concurrent send path. A turn
  that begins in a narrow pre-quiesce window may be interrupted; contested cursor changes
  are detected and never reported as successful swaps.
- Provider usage counters and LHC record size measure different things. LHC
  `tailTokens`/`compactRecommended` are the relevant LHC operation signals.
- Claude and Codex session formats are provider implementation details and must be checked
  when their CLIs change.
- Cursor and Grok are researched but intentionally not enabled; see the deferred design
  document.

## Deployment intention

The immediate operational goal is to run this fork as a web application on a local Linux
server. That server will host T3 Code and its authenticated provider CLIs, allowing a
browser on another machine to open projects and launch coding-agent sessions through the
T3 Code web UI. When the selected provider is Claude Code or Codex, the same thread will be
captured as an LHC session and the operator will be able to inspect its context health,
smart-compact it, or prune tool output directly from the web application.
