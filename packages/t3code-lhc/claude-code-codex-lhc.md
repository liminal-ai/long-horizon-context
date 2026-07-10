# Claude Code and Codex integration design

Claude Code and Codex are the implemented, prioritized providers in `t3code-lhc`. Both
have been validated end to end against real provider sessions:

```text
live turn
  -> normalized capture
  -> durable LHC record + derivations
  -> LHC compact/prune
  -> provider-native session rebuild
  -> persisted cursor flip
  -> next turn resumes rebuilt history
```

The integration reuses the proven provider-format work from `cc-lhc` and `codex-lhc`.
Those packages were informed by the earlier Claude/Codex session-cloning tools and then
supplemented by direct study and live probes against current provider rollout formats.
`t3code-lhc` ports the provider renderers rather than redoing the format research, while
replacing the earlier terminal-control machinery with T3 Code's typed runtime APIs.

## Common architecture

### Capture

T3 Code adapters emit one normalized `ProviderRuntimeEvent` stream. The LHC host attaches
one subscriber to this stream rather than tailing provider files independently. A second
hook observes accepted `sendTurn` input so exact user prompts are present even when the
provider event stream omits or duplicates them.

The mapper produces LHC message events for:

- user prompts;
- assistant text;
- assistant thinking/reasoning;
- tool calls and tool results;
- model changes;
- provider-native compaction notices;
- interrupted or failed turn notes; and
- turn boundaries.

Input is serialized per T3 thread. Each T3 thread receives a durable LHC thread through
`~/.t3code-lhc/t3code-lhc.sqlite`; the LHC SDK stores that thread's record and derivation
state in its own SQLite file.

Idempotency is built around stable T3 turn, item, and runtime-event identities. This
allows server restarts and repeated provider signals without duplicating recorded prompts
or messages. Live validation confirmed that a restarted server continued the same LHC
thread and recorded only the new turn.

### Background derivation

The server initializes LHC in background mode. Derivation requests use the `cc-lhc`
one-shot Claude provider pattern:

```text
LHC inference request -> bounded host queue -> claude -p --model sonnet
```

The host limits concurrent inference children and applies per-call timeouts. On shutdown,
capture stops accepting new input, flushes per-thread queues, waits for derivations up to a
cap, and kills remaining inference children. Manual mode preserves capture without paid
inference.

### Shared swap controller

Claude and Codex inject provider-specific behavior into one shared swap controller. The
provider strategy defines:

- supported provider names;
- resume-cursor decoding and validation;
- extraction of the old native session id;
- construction and verification of the next cursor;
- provider-home/session path resolution; and
- native-session rendering.

The shared controller provides:

- T3-to-LHC lineage resolution;
- per-thread swap locking;
- active-turn rejection;
- provider-binding validation;
- LHC compact/prune execution;
- `SessionThreadView` rendering;
- live-session quiescence;
- rebuilt-artifact prevalidation;
- flip-last cursor mutation;
- contested-flip detection and one bounded idle retry;
- structured timing/error receipts; and
- an LHC runtime note recording the swap.

A successful receipt therefore means more than “a file was written.” It means the new
artifact exists, the provider cursor was changed, the persisted binding read back as the
new session, and no live provider session was observed clobbering the change.

### Provider context versus durable context

Compact and prune do not delete the original LHC messages. They change the LHC serving
view and render that view into a new provider session. The durable record retains full
history and derivations while the model receives a smaller representation.

This distinction explains apparently different token numbers:

- provider counters include provider-specific system/tool baselines and may omit evicted
  tool output;
- LHC `tailTokens` reflects captured record content;
- rebuilt-session size reflects the currently served view.

## Claude Code

### T3 Code runtime

T3 Code wraps the Claude Agent SDK as a long-lived streaming session per T3 thread. A
prompt queue feeds the SDK query, and the server persists a resume cursor resembling:

```json
{
  "threadId": "<t3-thread-id>",
  "resume": "<claude-session-uuid>",
  "resumeSessionAt": "<last-assistant-uuid>",
  "turnCount": 7
}
```

Only `resume` is load-bearing for SDK resume. The cursor is read when a provider session
starts; changing the persisted cursor does not alter an already-running SDK query. The
swap must therefore stop the live session so the next turn starts from the rebuilt id.

### Capture fidelity patch

Claude did not provide all required data in the original normalized lifecycle payloads:

- user prompts were not emitted as canonical completed user messages;
- large tool results appeared as small persisted-output previews while the complete bytes
  were in Claude's sidecar output; and
- assistant reasoning needed explicit preservation.

The fork adds narrow Claude adapter enrichment so the normalized completed item exposes
the full tool result or appropriate carrier to the common mapper. User prompts are still
captured from the host send-turn hook. Live capture validation recorded a 108,927-byte
`seq 1 20000` tool result byte-for-byte and produced complete prompt, reasoning,
assistant, tool-call, and tool-result records.

### Rollout placement

Claude rollout files live at:

```text
<claude-home>/.claude/projects/<encoded-realpath-cwd>/<sessionId>.jsonl
```

The cwd encoding replaces characters outside `[A-Za-z0-9-]` with `-` after resolving the
real path. The integration derives the Claude home from the selected provider instance and
scans the projects tree for the source session id when needed.

### Rebuilt rollout format

The Claude renderer was ported from `cc-lhc`. It turns an LHC `SessionThreadView` into a
new parent-linked JSONL chain:

- each message has a fresh `uuid`;
- `parentUuid` points to the preceding line, beginning at `null`;
- every line carries the newly minted `sessionId` and the real cwd;
- user messages use role `user`;
- assistant messages use role `assistant` with text content and an end-turn stop reason;
- stable envelope metadata such as version, branch, entrypoint, and user type is copied
  from the source rollout where useful; and
- LHC bands are rendered as labeled context while the recent tail remains conversational
  history.

Thinking blocks, request metadata, diagnostics, queue-operation lines, and Claude's
session index are not required for resume. A synthetic rollout with no sessions-index
entry was accepted and appended to by Claude Code.

### Claude swap sequence

1. Validate the old `resume` UUID and locate its rollout.
2. Reject a thread with an active turn.
3. Execute LHC compact/prune and render the session view.
4. Stop the long-lived SDK session.
5. Write a new rollout under the same encoded project cwd.
6. Validate the file and new UUID.
7. Write:

   ```json
   {
     "threadId": "<t3-thread-id>",
     "resume": "<new-session-id>",
     "turnCount": "<carried-count>"
   }
   ```

8. Omit `resumeSessionAt` during the flip so metadata does not point at an assistant UUID
   absent from the rebuilt file.
9. Read back the binding and reject a contested write.
10. Let the next turn start a new SDK query with `queryOptions.resume = newSessionId`.

The first post-swap turn appends directly to the rebuilt rollout and restores a current
`resumeSessionAt` value.

### Claude failure behavior

Important cases:

- A malformed, non-UUID `resume` value is dropped by adapter parsing and may silently start
  fresh. The swap validates UUID shape before writing it.
- A valid UUID with no rollout is accepted lazily at session start but the first turn
  fails with “No conversation found with session ID.” The integration prevalidates the
  artifact, while still treating that first-turn error as a possible swap failure.
- A status-only provider-binding upsert preserves the old cursor. The swap actively writes
  the new cursor after quiescence.
- A provider session that restarts around the flip can rewrite the old cursor. The shared
  controller detects pre- and post-write contention and does not return success.

### Native compaction suppression

When LHC capture is active, the fork passes `settings.autoCompactEnabled: false` into
Claude sessions unless explicitly overridden. This prevents Claude's native compactor and
LHC from independently changing context near the same boundary.

### Claude validation

Real-server acceptance demonstrated:

- full capture of a 528,927-byte tool result;
- LHC `tailTokens` reaching 940,055 while Claude's provider counter remained near its
  baseline because Claude evicted tool output;
- compact receipt and cursor flip in roughly 169 ms;
- exact recall of an unrestated codename and number after resume;
- continued turns on the same LHC lineage and rebuilt rollout;
- chained prune followed by another successful resume;
- clean derivation drain and zero LHC warnings; and
- correct `404 not_captured` and `409 busy` behavior.

Organic dogfooding later compacted a real conversation whose provider UI showed roughly
203k tokens. The resulting LHC view retained the recent tail verbatim and compressed the
earlier, tool-heavy exploration into a small smooth band. A content audit found the tail
byte-exact, all pre-boundary material accounted for, and no fabricated facts.

## Codex

### T3 Code runtime

T3 Code launches `codex app-server` and speaks JSON-RPC over stdio. It starts or resumes
Codex threads using app-server methods and persists the minimal cursor:

```json
{ "threadId": "<codex-thread-id>" }
```

Codex session data lives under the selected `CODEX_HOME`. In direct mode this is normally
`~/.codex`; T3 Code can also use a controlled shadow-home layout.

### Capture fidelity

Codex's normalized completed items already preserve the information LHC needs. Host-side
prompt injection and provider user-message events share turn-scoped idempotency keys, so
the same prompt is not recorded twice. Completed command events expose full aggregated
output. Live validation captured 108,938-byte and later 468,938-byte tool outputs without
truncation.

### Rollout placement

Codex rollouts live under dated directories:

```text
<CODEX_HOME>/sessions/YYYY/MM/DD/
  rollout-YYYY-MM-DDTHH-MM-SS-<threadId>.jsonl
```

The implementation searches by rollout filename suffix rather than assuming a specific
date.

### Rebuilt rollout format

The renderer was ported from `codex-lhc`, whose format work combined earlier cloning
experience with study of current Codex rollouts. A rebuilt file contains:

1. a first-line `session_meta` envelope;
2. model-visible `response_item` user/assistant messages; and
3. replay-visible `event_msg` user/assistant messages.

The identity invariant is mandatory:

```text
filename thread id
  == session_meta.payload.id
  == session_meta.payload.session_id
```

The source cwd is retained. Metadata such as CLI version and base instructions may be
copied from the source. Tool call/output protocol records are not synthesized from the LHC
view; rendered context uses model-visible text so it cannot create unmatched function-call
records. No prewrite to Codex SQLite, `history.jsonl`, or `session_index.jsonl` is required.
Codex app-server catalogs the rollout as a side effect of loading it.

### App-server resume proof

Before implementation, the integration tested the precise path T3 Code uses—not merely
`codex exec resume`:

- app-server accepted a synthetic rollout written after the process started;
- a fresh app-server process accepted a preexisting synthetic rollout;
- both recalled fabricated history and appended the new turn to the synthetic file;
- missing files failed immediately;
- malformed first-line metadata was rejected; and
- `thread/fork` also accepted synthetic history but was not needed for the primary design.

This retired the final structural uncertainty in the Codex path.

### Codex swap sequence

1. Validate the old cursor as a UUID-shaped Codex thread id.
2. Locate the old rollout under the provider's effective Codex home.
3. Reject an active turn and stop the Codex provider session.
4. Execute LHC compact/prune and render the serving view.
5. Mint a new id and atomically write the dated rollout.
6. Validate that filename and both metadata ids agree.
7. Write the next cursor:

   ```json
   { "threadId": "<new-codex-session-id>" }
   ```

8. Read back the persisted binding and reject contention.
9. On the next turn, resume through app-server `thread/resume` and verify the returned
   thread id matches the rebuilt id.

### Codex failure behavior

Important cases:

- app-server itself loudly rejects a missing rollout, but T3 Code's Codex runtime can
  interpret a not-found resume error as recoverable and start a fresh thread. The swap
  therefore prevalidates the file and requires identity consistency.
- A filename/`session_meta` mismatch can load by filename but return the metadata id. T3
  Code would then persist the wrong id; the writer enforces equality.
- The first rollout line must be valid `session_meta`. Later malformed lines may be
  skipped by Codex, but production always writes clean JSONL.
- A binding upsert that omits `resumeCursor` does not flip the session.
- The thread cwd is preserved through provider runtime-payload merge semantics and is used
  to render and resume the rebuilt context.

### Codex validation

Real-server acceptance demonstrated:

- monotonic provider-context growth across tool-heavy turns;
- LHC `tailTokens` reaching 596,608;
- compact followed by exact unrestated codename/number recall;
- provider context dropping from 27,506 to 14,520 tokens;
- new turns appending to the rebuilt file;
- a second compact on an explicitly stopped/quiesced thread;
- chained prune and successful continuation;
- mixed-provider dispatch proving that Claude still used the Claude strategy;
- complete derivation health with zero failures; and
- correct busy and unknown-thread responses.

Organic dogfooding later pruned a one-prompt Codex thread containing 96 tool calls. The
operation pruned 64 old tool results, reduced the served historical zone from 128,888 to
28,162 tokens, and flipped the cursor in approximately 36 ms. Codex's own context display
dropped from roughly 141k to 67k on the next turn while the full LHC record remained
available.

## HTTP and web integration

The authenticated HTTP controller dispatches compact/prune according to the captured
thread's provider kind. Inspect/status are provider-independent; compact/prune select the
Claude or Codex strategy. Errors carry a code, last reached step, retriable flag, and
optional detail.

The web context-ring popover enables actions only when:

- the thread is captured;
- `providerKind` is `claudeAgent` or `codex`; and
- no turn is in flight.

A successful action displays a toast based on the structured receipt and refreshes LHC
status. The server remains authoritative for races and may still return `409 busy`,
`swap_in_progress`, or `flip_contested`.

## Operational certification

The fork includes a sync-smoke command used after upstream merges or deployments. It:

- creates isolated T3 and LHC homes;
- boots the exact server build on an ephemeral port;
- verifies process identity using pid and `startedAt`;
- runs real Claude and Codex turns;
- verifies prompt and full tool-result capture;
- compacts Claude and prunes Codex;
- verifies rebuilt artifacts and cursor changes;
- asks each provider to recall a seeded fact; and
- checks LHC status and derivation health before teardown.

The first complete certification passed all thirteen steps in under a minute. This is the
minimum deployment gate for maintaining the fork across upstream T3 Code updates.

## Current limits

- T3 Code rollback/fork commands do not rewrite LHC lineage.
- A narrow turn-start race before quiescence can interrupt a turn; its captured content may
  remain in LHC but not enter the newly rebuilt provider session.
- Cursor-flip contention is detected rather than globally prevented.
- Provider rollout formats are private implementation contracts and require regression
  probes as CLI versions change.
- Claude and Codex are intentionally the only providers exposed in the LHC web controls at
  this time.
