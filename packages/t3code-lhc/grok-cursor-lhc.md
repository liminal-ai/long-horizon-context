# Deferred Grok and Cursor integration design

## Status and priority

Research has established viable LHC session-rebuild designs for both Grok and Cursor in
T3 Code. Both providers keep authoritative local session state, and both accepted
synthetic sessions through the same ACP `session/load` path T3 Code uses. Neither provider
requires a lower-fidelity “start fresh and paste a summary” fallback.

Implementation is nevertheless deferred. Claude Code and Codex are the prioritized
long-running interactive sessions for `t3code-lhc`. Grok and Cursor are expected to be
used more often for transient agents, verification, or bounded tasks where investing in
progressive long-horizon context management is less urgent. Their LHC actions therefore
remain hidden in the web UI and their events are excluded from production capture.

This document preserves the completed research and recommended implementation plan so the
work can resume without repeating format archaeology.

## Executive assessment

| Area | Cursor | Grok |
| --- | --- | --- |
| Transport | ACP JSON-RPC | ACP JSON-RPC |
| Resume | `session/load` | `session/load` |
| Resume cursor | `{schemaVersion:1, sessionId}` | `{schemaVersion:1, sessionId}` |
| Native session authority | Local SQLite content-addressed graph | Local session directory |
| Synthetic resume proof | Passed with hand-authored graph | Passed with hand-authored JSONL |
| Capture readiness | Shared ACP fixes required | Shared ACP fixes plus Grok fixes required |
| Tool-output fidelity | Full bytes reach normalized stream | ACP truncates large output to preview |
| Rebuilder complexity | High | Moderate |
| Recommended order | Second | First |

The fundamental architecture is not blocked. The remaining effort is implementation and
fidelity hardening, not feasibility research.

## Shared ACP host architecture

Cursor and Grok both run behind T3 Code's ACP runtime. T3 Code launches an ACP child,
initializes and authenticates it, creates or loads a session, sends prompts, and consumes
`session/update` notifications. The adapters translate those updates into the same
`ProviderRuntimeEvent` vocabulary used by the rest of T3 Code.

For resume, both adapters persist:

```json
{
  "schemaVersion": 1,
  "sessionId": "<provider-session-id>"
}
```

If the cursor parses, `AcpSessionRuntime` sends `session/load` with the session id, cwd,
and MCP configuration. If the cursor is malformed, the adapter omits `resumeSessionId`
and silently follows `session/new`. Any future LHC swap must validate the exact cursor
shape before writing it.

The intended swap path is the same as Claude/Codex:

```text
LHC compact/prune
  -> SessionThreadView
  -> provider-specific ACP session writer
  -> stop ACP child
  -> write new local session
  -> flip persisted {schemaVersion:1, sessionId}
  -> next turn starts ACP child and calls session/load
```

The existing shared swap controller can be extended with Grok and Cursor strategies. Its
lineage, busy checks, lock, view rendering, quiescence, flip-last invariant, contested-flip
detection, runtime notes, and receipts should remain common.

## Capture research

A live fidelity probe used the production Cursor and Grok adapters, production ACP
runtime/parser/state merger, and current LHC mapper. Each provider ran two authenticated
turns in a scratch git repository:

1. a deterministic assistant-only response; and
2. a deterministic command producing approximately 60 KiB of output.

The normalized events were then passed through the current LHC mapper offline, with the
same host-side prompt injection production capture uses.

### Shared capture result

Simply adding `cursor` and `grok` to `CAPTURED_DRIVER_KINDS` would produce incomplete LHC
records:

- exact user prompts would be captured through the host hook;
- normal turn starts/completions would be represented;
- assistant text would be absent for both providers;
- tool status would survive;
- tool-result content would collapse to a 32-byte status marker; and
- raw output would be misclassified as tool-call arguments.

The cause is structural:

1. ACP assistant text arrives as `content.delta` events.
2. Current ACP completed-assistant events contain only item id/type/status, not text.
3. The LHC mapper intentionally ignores deltas because Claude/Codex capture was designed
   around complete lifecycle events.
4. Therefore there is no text left when the mapper handles ACP assistant completion.

The mapper must gain an ACP delta accumulator keyed by thread, turn, and assistant segment.
It should emit the accumulated text once when a matching completion arrives, or flush
unclosed segments immediately before the turn ends. Idempotency must be turn-scoped rather
than rely only on ACP's synthetic assistant id, because the segment counter resets when an
ACP runtime is recreated and may collide after resume.

### Shared tool mapping result

The ACP tool-state merger preserves `rawInput`, `rawOutput`, `content`, status, and
locations. The generic LHC mapper does not read ACP's actual output fields. Instead, its
fallback argument builder copies most of the provider data object into tool-call arguments.

Required generic correction:

- derive tool arguments from `rawInput`/actual input fields only;
- exclude `rawOutput`, result content, locations, and result metadata from arguments;
- derive result text from ACP `rawOutput.stdout`, textual `content`, or byte-array output;
- preserve status, exit code, and error state;
- carry an explicit truncation marker when ACP reports a preview; and
- never present a provider preview as full capture.

## Grok design

### Feasibility verdict

**REBUILD is proven.** Grok's ACP `session/load` resolves a local session directory, and
the model consumes local `chat_history.jsonl` as authoritative history. A scratch copy
with edited assistant text caused the resumed model to recall the edited fact. Two wholly
synthetic session directories also loaded and produced exact recall of facts never sent to
the provider previously.

No Grok server-side thread registration or signature is required for plaintext history.

### Home and discovery

Grok supports `GROK_HOME`, which isolates session and catalog state. A session is located
under:

```text
$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<sessionId>/
```

Discovery depends on both session id and cwd. The directory component is the URL-encoded
absolute cwd. A mismatched cwd produces a loud filesystem-not-found error.

Grok accepts UUIDv4 session ids even though provider-created ids may resemble UUIDv7.

### Per-session files

Observed session files include:

| File | Purpose | Load requirement |
| --- | --- | --- |
| `summary.json` | Session metadata, id, cwd, model, counts | Required |
| `chat_history.jsonl` | Model-visible conversation | Required for useful recall |
| `updates.jsonl` | ACP replay stream used to reconstruct client/UI history | Optional for load, required for coherent replay |
| `system_prompt.txt` | System-prompt mirror | Optional |
| `events.jsonl`, `signals.json`, `prompt_context.json`, `rewind_points.jsonl`, edit records | Telemetry and auxiliary state | Not required by the proven minimal load path |

`session_search.sqlite` lives above the cwd directories. It is a search/catalog side
effect rather than a load input. Synthetic sessions loaded before any catalog row was
created, and missing sessions failed by filesystem path rather than database lookup.

### Two authoritative views

Grok maintains two independent representations that can disagree:

- the **model** reads `chat_history.jsonl`;
- ACP **replay/UI** reads `updates.jsonl`.

The probe edited only `chat_history.jsonl`. ACP replay still displayed the original text,
but the model recalled the edited text. Therefore a correct renderer must write both files
from the same LHC view. Writing only `updates.jsonl` would make the UI look correct while
the model sees stale history; writing only `chat_history.jsonl` would give the model correct
context but misleading or empty replay.

### Minimal model-history format

A proven synthetic `chat_history.jsonl` used:

```json
{"type":"system","content":"<system prompt>"}
{"type":"user","content":[{"type":"text","text":"<user_query>...</user_query>"}]}
{"type":"assistant","content":"<assistant text>","model_id":"grok-composer-2.5-fast","model_fingerprint":"synthetic"}
```

Encrypted reasoning is not required. Synthetic sessions omitted reasoning lines and Grok
created valid reasoning data for new turns appended after resume.

The production renderer should:

- preserve or generate a suitable system line;
- render LHC context bands as model-visible user/assistant text;
- retain recent conversational turns as ordinary history;
- avoid synthesizing unsupported tool protocol records;
- omit encrypted reasoning from historical context; and
- append a runtime-note exchange identifying the LHC operation if useful.

### Minimal replay format

`updates.jsonl` lines are timestamped ACP notifications. A sufficient replay includes:

- `session/update user_message_chunk`;
- `session/update agent_message_chunk`; and
- `_x.ai/session/update turn_completed`.

Thought chunks are optional. Every replay line must reference the newly minted session id
and correspond to the same content rendered into `chat_history.jsonl`.

### Required summary metadata

`summary.json` is load-bearing. A minimal accepted shape includes:

```json
{
  "info": { "id": "<new-id>", "cwd": "<cwd>" },
  "session_summary": "<short description>",
  "created_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>",
  "num_messages": 2,
  "num_chat_messages": 3,
  "current_model_id": "<model>",
  "next_trace_turn": 1,
  "chat_format_version": 1,
  "grok_home": "<GROK_HOME>",
  "agent_name": "cursor"
}
```

The directory id and `summary.json.info.id` were not validated against each other in the
probe, but production must keep them identical to avoid future reader ambiguity.

### Grok capture gaps

Grok has two provider-specific capture problems beyond the shared mapper work.

#### Assistant lifecycle ownership

In live back-to-back turns, a delayed assistant completion was attributed to the next turn,
and the final segment had no normalized completion. The adapter currently resolves the
notification turn from mutable current state; after a turn clears, delayed completion may
be dropped, and after the next turn begins it may inherit the wrong turn.

The adapter should bind each assistant segment to the T3 turn active when that segment is
created and drain/close its lifecycle before clearing ownership. Tests should include:

- back-to-back turns;
- final assistant completion after provider turn settlement;
- interrupted turns;
- session stop; and
- resume with segment counters reset.

The LHC delta accumulator should still be able to flush text at turn end, but canonical ACP
lifecycle events should also be corrected for other consumers.

#### Large tool-output truncation

For a command producing 61,480 bytes, Grok ACP reported `truncated:true` and
`total_bytes:61480` but supplied only a 20,030-byte head/tail preview. The missing 41,450
bytes were absent before T3 normalization and cannot be reconstructed by a generic mapper.

Before claiming full-fidelity Grok capture, implementation must determine whether the full
result is available in:

- another Grok session file;
- an event or telemetry sidecar;
- a tool-specific output path included outside the normalized preview; or
- a controllable Grok configuration that raises/disables the preview cap.

If full output is recoverable, add a narrowly scoped adapter-side carrier with explicit
size limits and cleanup, analogous in intent to the Claude persisted-output patch. If it
is not recoverable, record the preview with an explicit marker containing
`truncated=true`, `total_bytes`, and captured byte count. Do not call that full fidelity.

### Grok swap strategy

A future Grok strategy should:

1. parse and validate `{schemaVersion:1, sessionId}`;
2. derive the effective `GROK_HOME` and persisted cwd;
3. locate the old session and read metadata/system context;
4. stop the live ACP session;
5. create a new UUID and temporary sibling directory;
6. write `summary.json`, `chat_history.jsonl`, and `updates.jsonl` from the same LHC view;
7. fsync files/directories as practical and atomically rename the directory into place;
8. verify required files and id/cwd invariants;
9. write `{schemaVersion:1, sessionId:newId}` as the final provider-state mutation;
10. verify the persisted cursor and absence of a restarted ACP session; and
11. on the next turn, require `session/load` to return the same id and append to the new
    history.

A missing directory or `summary.json` fails loudly with `FS_NOT_FOUND`. A malformed T3
cursor is more dangerous because adapter parsing silently falls back to `session/new`.

## Cursor design

### Feasibility verdict

**REBUILD is proven.** Cursor's local ACP session store is authoritative. Three stores
with different local content produced three different model recalls:

- an unmodified real session recalled its original codename;
- a copied graph with edited plaintext recalled the edited codename; and
- a graph authored from scratch recalled a fact never generated by a model.

The synthetic graph omitted opaque signed reasoning data, demonstrating that plaintext
conversation history is neither cloud-only nor signature-gated.

### Home and discovery

Cursor ACP sessions live at:

```text
~/.cursor/acp-sessions/<sessionId>/
  store.db
  meta.json
```

Session lookup is keyed by session id alone; loading from a different cwd succeeded. The
rebuilt metadata should still preserve the T3 thread cwd because Cursor includes cwd in
model/user environment context.

### Content-addressed store

`store.db` contains:

```sql
blobs(id TEXT PRIMARY KEY, data BLOB)
meta(key TEXT PRIMARY KEY, value TEXT)
```

Every blob obeys:

```text
id == sha256(blob data)
```

The `meta` row uses key `0`. Its value is hex-encoded JSON containing fields such as:

- `agentId`;
- `latestRootBlobId`;
- `name`;
- `mode`;
- `isRunEverything`; and
- `createdAt`.

`meta.json` carries schema version, cwd, and title.

The store is a content-addressed Merkle DAG rather than a transcript table. Editing one
message changes its blob hash, every ancestor reference, and ultimately the root id.
Production should author a new graph rather than mutate a copied one by byte replacement.

### Message blobs

Plain UTF-8 JSON blobs represent:

- system prompt;
- user/environment information;
- user queries; and
- assistant messages.

Assistant messages may contain opaque redacted-reasoning data, but this is optional for a
synthetic rebuild. A minimal historical assistant message with ordinary text was accepted.

### Protobuf graph

Binary protobuf-wire blobs form the graph around JSON messages. The observed roles were:

1. **context node** — references system prompt and user information;
2. **user-turn node** — references user text, ids, and context;
3. **assistant text node** — wraps assistant text;
4. **conversation node** — references the turn and assistant nodes; and
5. **root node** — references the flat message list, conversation graph, cwd, git branch,
   originator, timestamps, and context-budget metadata.

The root id is written to `meta.latestRootBlobId`. Historical unused roots may remain in a
provider-created store, but a new synthetic store needs only a coherent reachable graph.

Opaque reasoning/signature fields can be omitted from historical nodes. Cursor will append
its own valid provider-native content on the next live turn.

### Cursor renderer

The recommended production renderer is a small, separately tested library that:

1. renders an LHC `SessionThreadView` into plain system/user/assistant message values;
2. encodes those values as the observed JSON blobs;
3. encodes protobuf nodes with a minimal explicit wire encoder;
4. computes SHA-256 for every blob;
5. threads raw 32-byte child hashes through parent nodes;
6. builds a minimal context-budget tree with internally consistent byte/token metadata;
7. creates a fresh SQLite database with `blobs` and `meta` tables;
8. verifies `sha256(data) == id` for every inserted row;
9. writes hex-encoded metadata pointing at the generated root; and
10. writes `meta.json` with schema version 1, cwd, and title.

The writer should not depend on copied encrypted reasoning or on provider-created opaque
tokens. The from-scratch probe proved those fields are unnecessary.

### SQLite safety

Cursor uses SQLite WAL. Directly copying or replacing a live store with stale `-wal` or
`-shm` files can expose old state. The swap must stop the ACP child first and create a fresh
store in a temporary session directory. The final directory should contain the committed
`store.db` and metadata with no stale WAL/SHM sidecars. Atomic directory rename is
preferable to in-place graph mutation.

### Cursor capture gaps

Cursor shares the assistant-delta and generic tool-mapping problems described above, but
its provider stream retains the full tool output.

For a 61,484-byte command result:

- raw ACP completion contained all 61,484 bytes in `rawOutput.stdout`;
- normalized completion preserved the exact bytes in `data.rawOutput.stdout`; and
- the current LHC mapper emitted zero command-output bytes in `tool_result.content` while
  copying the output into tool-call arguments.

Therefore Cursor full-fidelity capture requires no provider sidecar. A generic ACP mapper
fix can recover it.

Cursor assistant lifecycle events were correctly associated within the live session, but
synthetic assistant ids use a runtime-local segment counter. Recreating the runtime for the
same ACP session can restart the counter and collide with historical idempotency keys. The
accumulator should use turn-scoped keys, and the shared ACP runtime should eventually mint
restart-safe assistant identities.

### Cursor swap strategy

A future Cursor strategy should:

1. parse and validate `{schemaVersion:1, sessionId}`;
2. derive `~/.cursor/acp-sessions` and the persisted cwd;
3. stop the live ACP session before opening/replacing any store;
4. render the LHC view into a newly authored Merkle DAG;
5. write a fresh temporary `store.db` and `meta.json`;
6. run a full graph integrity check:
   - every blob hash matches its id;
   - all referenced child ids exist;
   - the metadata root exists;
   - JSON and protobuf node roles are structurally valid;
7. atomically install the new session directory under a fresh UUID;
8. verify there are no stale WAL/SHM files;
9. write `{schemaVersion:1, sessionId:newId}` as the final provider-state mutation;
10. read back and verify the cursor; and
11. require the next ACP load to use the rebuilt id and recall/append correctly.

An unknown Cursor session id fails loudly at ACP with `Invalid params`, but malformed cursor
shape is silently treated as a new session by the T3 adapter. Both file existence and cursor
shape must be checked before flipping.

## Recommended implementation plan

The work should be resumed only if Grok or Cursor becomes a priority for long-running T3
Code sessions. At that point, implement shared capture correctness before either swap.

### Phase 0 — Reconfirm versions and policy

- Pin the tested Cursor and Grok CLI versions.
- Re-run minimal format/load probes if versions changed materially.
- Decide whether Grok preview-only tool output is acceptable. For normal LHC fidelity, the
  recommendation is to require full output or explicitly label the provider as degraded.
- Decide whether both providers are needed or only one.

### Phase 1 — Shared ACP assistant capture

- Extend LHC turn/segment state to accumulate `content.delta` by thread, turn, and item.
- Emit assistant text on completion.
- Flush remaining assistant segments before `turn_end` when completion is delayed/missing.
- Make idempotency turn-scoped and safe across provider resume.
- Add fixtures for multiple assistant segments, completion-after-turn, missing completion,
  cancellation, and replay.
- Re-run byte-exact live assistant capture for both providers.

### Phase 2 — Shared ACP tool mapping

- Decode `rawInput` into clean tool arguments.
- Decode Cursor `rawOutput.stdout` into full tool-result content.
- Decode Grok textual/byte-array preview content.
- Preserve status, exit code, error, and truncation metadata.
- Prevent output and result metadata from leaking into tool-call arguments.
- Add size limits and tests for malformed provider payloads.
- Re-run the 60 KiB fidelity probe.

### Phase 3 — Canonical ACP lifecycle hardening

- Enrich completed assistant events with accumulated text at the shared ACP runtime layer.
- Make segment identity restart-safe.
- Fix Grok's delayed-completion turn ownership and final-segment drop.
- Test back-to-back, interrupted, stopped, and resumed sessions.

This phase benefits T3 Code beyond LHC because it repairs the normalized provider event
contract for all consumers.

### Phase 4 — Grok full-output decision

- Inspect Grok's local session artifacts after a large tool call for full output.
- Check whether configuration can raise/disable the ACP truncation cap.
- If full bytes exist, surface them through a bounded adapter carrier.
- If not, encode explicit degraded/truncated capture semantics and obtain an explicit
  product decision before enabling LHC capture.

### Phase 5 — Enable capture

- Add only accepted provider kinds to `CAPTURED_DRIVER_KINDS`.
- Live-validate lineage, exact prompt count, assistant text, tool calls/results, turn
  closure, restart idempotency, inference drain, and disabled/manual modes.
- Keep compact/prune actions hidden at this stage.

### Phase 6 — Grok renderer and swap

Grok should be first because its storage is conventional JSON/JSONL and its ACP resume
behavior is already well characterized.

Suggested slices:

1. home/cwd/session layout resolver;
2. pure `SessionThreadView` to Grok history/replay renderer;
3. atomic session-directory writer with metadata validation;
4. Grok strategy plugged into the shared swap controller;
5. unit/golden tests and failure-surface tests; and
6. live compact, prune, resume recall, second swap, and restart acceptance.

### Phase 7 — Cursor renderer and swap

Cursor should follow because it is feasible but format-sensitive.

Suggested slices:

1. minimal protobuf wire codec and documented node types;
2. content-addressed graph builder with structural verifier;
3. SQLite/meta writer with WAL-safe atomic installation;
4. golden tests against the proven minimal synthetic shape;
5. Cursor strategy plugged into the shared swap controller; and
6. live compact, prune, resume recall, second swap, and restart acceptance.

### Phase 8 — UI and operations

Only after each provider passes live acceptance:

- add its provider kind to the context-popover action gate;
- expose inspect/status data without changing existing Claude/Codex behavior;
- add it to sync-smoke behind provider-specific skip flags;
- update Linux deployment prerequisites and authentication checks; and
- run a mixed-provider regression proving all enabled strategies dispatch correctly.

## Acceptance criteria

A provider should not be marked supported until all of the following are true:

1. exact user prompts appear once;
2. assistant text is complete and ordered;
3. tool call arguments exclude result payloads;
4. tool result fidelity is full or explicitly declared degraded;
5. normal, interrupted, and failed turns close correctly;
6. restart/resume does not duplicate old content;
7. compact and prune preserve the LHC record;
8. rebuilt session identity is validated before cursor flip;
9. next-turn recall proves the provider loaded the rebuilt context;
10. the provider appends new turns to the rebuilt session;
11. a second swap works on an already rebuilt session;
12. busy and contested-flip errors do not report false success;
13. derivations drain without failed/blocked work; and
14. Claude/Codex regression smoke remains green.

## Estimated effort

If implemented together, the shared ACP work reduces duplication. A reasonable breakdown
is:

- 2–3 shared capture/lifecycle slices;
- 3–4 Grok-specific slices, depending on full-output recovery;
- 3–4 Cursor-specific slices because of the Merkle/protobuf/SQLite writer; and
- 1 combined UI, operations, and mixed-provider closeout.

That is approximately 8–11 substantive slices after policy decisions and version
reconfirmation. The feasibility risks are retired, but the fidelity and renderer work is
substantial enough that deferral is appropriate while Grok and Cursor sessions remain
primarily transient.
