# Codex CLI rollout/session file format report

Investigation date: 2026-07-07  
Installed CLI checked: `codex-cli 0.142.5`  
Scope: read-only inspection of `/Users/leemoore/code/.older/cxs-cloner`, `/Users/leemoore/.codex/sessions`, `/Users/leemoore/.codex/session_index.jsonl`, `/Users/leemoore/.codex/history.jsonl`, sqlite schemas under `/Users/leemoore/.codex`, and local installed package/binary strings. The only write performed by this investigation was this report file.

## Executive summary

Observed fact: a Codex rollout is newline-delimited JSON. Each line has a top-level envelope shaped as `{ "timestamp": string, "type": string, "payload": object }`. The active session id is the UUID suffix in `rollout-<local-ish timestamp>-<uuid>.jsonl`; in all sampled files it matches the first top-level `session_meta.payload.id`, and current files also usually include `session_meta.payload.session_id` equal to that id.

Observed fact: `cxs-cloner` successfully clones by preserving a valid `session_meta`, preserving/synthesizing replay-facing `event_msg` records, stripping many tool/telemetry records, minting a new UUID, writing one default-location rollout file under `~/.codex/sessions/YYYY/MM/DD/`, and appending `~/.codex/session_index.jsonl` only when it has a thread name. It does not write sqlite state, `history.jsonl`, or source files. Evidence: pipeline and write order in `src/core/clone-operation-executor.ts:36-134`, path generation in `src/io/session-file-writer.ts:11-34`, and session-index append in `src/io/session-index-file.ts:96-112`.

Observed fact: Codex 0.142.5 maintains sqlite state. `/Users/leemoore/.codex/state_5.sqlite` has a `threads` table with `id`, `rollout_path`, `created_at`, `updated_at`, `source`, `cwd`, `title`, `archived`, `cli_version`, `thread_source`, `preview`, etc. It had 3345 rows, matching the 3345 rollout files scanned. The installed native binary contains strings for `rollout/src/state_db.rs`, `rollout/src/list.rs`, `tui/src/resume_picker.rs`, `tui/src/session_resume.rs`, "state DB contains matching thread rows", "state DB is missing while rollout files exist", and "Start Codex with no state DB present so startup backfill can create it from rollout files." This is strong evidence that current Codex uses sqlite as a catalog/cache, with filesystem rollout backfill/reconciliation.

Inference: for a synthetic rollout intended for `codex resume <id>`, the most robust path is:

1. Write a rollout at `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<new-id>.jsonl`.
2. Make line 1 a `session_meta` whose `id` and, for 0.142.x, `session_id` equal `<new-id>`.
3. Include at least one model-visible history line as `response_item` `message` (user/assistant) and at least one `event_msg` `user_message` for replay/list compatibility.
4. Optionally append `session_index.jsonl` with `{id, thread_name, updated_at}` for a friendly name.
5. Let Codex backfill sqlite on next startup/reconcile, or explicitly upsert sqlite only if you intentionally depend on immediate picker/`--last` visibility in a still-running app server.

The highest risk: cxs-cloner predates several 0.142.5 schema additions (`session_id`, `internal_chat_message_metadata_passthrough`, `tool_search_call`, `tool_search_output`, `image_generation_*`, many event types, sqlite catalog). Its successful compatibility smoke tests still matter, but a new wrapper should preserve unknown fields by default and not assume the cxs type list is exhaustive.

## Phase 1: cxs-cloner behavior

### Discovery

Observed fact: default Codex home is `join(homedir(), ".codex")`, overridable by `CXS_CLONER_CODEX_DIR` or CLI `--codex-dir`. Evidence: `src/config/default-configuration.ts:12-24`, `src/commands/clone-command.ts:86-90`, `src/commands/list-command.ts:45-50`.

Observed fact: session discovery is filesystem-only. `scanSessionDirectory(codexDir)` walks `${codexDir}/sessions` recursively, filters names matching `^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$`, derives `threadId` from the filename suffix, and sorts newest-first by the timestamp parsed from the filename. Evidence: `src/io/session-directory-scanner.ts:14-31`, `src/io/session-directory-scanner.ts:34-104`.

Observed fact: lookup by id is filename-prefix based, not `session_meta` based, sqlite based, or `session_index.jsonl` based. `findSessionByPartialId` scans files and filters `session.threadId.startsWith(partialId)`. Evidence: `src/io/session-directory-scanner.ts:106-143`.

Observed fact: `session_index.jsonl` is read only to derive a human thread name. It is not used to find rollout paths. Evidence: `readSessionIndexName` reads `${codexDir}/session_index.jsonl`, tracks the last `thread_name` for an id, and returns it or null; `executeCloneOperation` uses it only to name the clone. See `src/io/session-index-file.ts:11-78` and `src/core/clone-operation-executor.ts:81-94`.

Observed fact: cxs-cloner does not touch `history.jsonl` or sqlite state. No code references `history.jsonl` or sqlite; the discovery and write modules are `sessions/` plus optional `session_index.jsonl`.

### Clone write order and side effects

Observed fact: the executor pipeline is explicitly documented and implemented as: find source, parse, identify turns, strip, generate identity, compatibility guard, update meta, optionally rewrite cwd, write output, append session index, merge statistics. Evidence: `src/core/clone-operation-executor.ts:36-41`, `src/core/clone-operation-executor.ts:45-134`.

Observed fact: for a default-location clone, the rollout path is:

```text
{codexDir}/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<threadId>.jsonl
```

The directory and filename timestamp are derived from the clone timestamp using local `Date` getters, not `toISOString`. Evidence: `src/io/session-file-writer.ts:11-34`.

Observed fact: the writer creates parent directories, serializes each record with `JSON.stringify`, writes to a temporary sibling `.<uuid>.tmp`, stats the temp file, then renames it atomically into place. Evidence: `src/io/session-file-writer.ts:36-103`.

Observed fact: after the rollout file is written, cxs-cloner appends `{"id": newId, "thread_name": cloneName, "updated_at": cloneTimestamp}` to `${codexDir}/session_index.jsonl` only if the clone is in the default location and a name exists. If that append fails, it deletes the just-written rollout file. Evidence: `src/core/clone-operation-executor.ts:118-134`, `src/core/clone-operation-executor.ts:335-340`, `test/integration/clone-operation-executor.test.ts:774-797`.

Observed fact: custom output paths are treated as not resumable and skip `session_index.jsonl`. Evidence: `src/core/clone-operation-executor.ts:151-162`, `src/output/clone-result-formatter.ts:76-81`, `test/integration/clone-operation-executor.test.ts:180-199`, `test/integration/clone-operation-executor.test.ts:505-532`.

### Identity minting and metadata rewriting

Observed fact: cxs-cloner mints the new session/thread id with `randomUUID()`, not a time-sortable UUIDv7. It records `cloneTimestamp = new Date()` and `sourceThreadId = parsed.metadata.id`. Evidence: `src/core/clone-operation-executor.ts:74-79`.

Observed fact: it rewrites only the first `session_meta` it finds, setting the line envelope timestamp, `payload.id`, `payload.forked_from_id`, and `payload.timestamp`. It then returns. Evidence: `src/core/clone-operation-executor.ts:166-184`.

Observed fact: it does not rewrite response item ids, function call ids, turn ids, event ids, originator, source, model provider, base instructions, dynamic tools, or most timestamps. Those fields are copied from the structured clone unless removed/truncated by stripping. Evidence: `stripRecords` begins with `structuredClone(records)` in `src/core/record-stripper.ts:34-47`; only `updateSessionMeta`, `rewriteWorkingDirectory`, stripping, and compatibility synthesis mutate fields.

Observed fact: when `--target-cwd` is supplied, it rewrites `session_meta.payload.cwd` and every `turn_context.payload.cwd`; it recomputes git metadata from the target directory, or deletes `payload.git` for non-git targets. Evidence: `src/core/clone-operation-executor.ts:102-108`, `src/core/clone-operation-executor.ts:186-212`, `test/integration/clone-operation-executor.test.ts:956-1119`.

Important drift: current 0.142.5 `session_meta` has both `id` and `session_id` in observed files. cxs-cloner only rewrites `id`; it does not know about `session_id`. For source files that include `session_id`, a clone could have `payload.id` equal to the new id while `payload.session_id` remains the old id. The cxs tests predate or do not assert that field. Current real samples show `session_id` is present in 0.142.x files; see the 2026-07-07 current session sample below.

### Stripping and coherence

Observed fact: cxs-cloner classifies tool calls by response-item subtype: `function_call`, `local_shell_call`, `custom_tool_call`, and `web_search_call`. It classifies paired outputs by subtype: `function_call_output`, `custom_tool_call_output`. Evidence: `src/core/record-stripper.ts:17-30`.

Observed fact: turn boundaries are top-level `turn_context` records. After a top-level `compacted` record, only `turn_context` records after the last compaction are considered for turn zoning. Evidence: `src/core/turn-boundary-calculator.ts:15-28`, `src/core/turn-boundary-calculator.ts:32-88`.

Observed fact: for removed-zone tool turns, cxs removes tool call records and removes paired function/custom outputs by shared `call_id`. Standalone `local_shell_call` and `web_search_call` are removed as standalone records. Evidence: `src/core/record-stripper.ts:70-119`, tests in `test/core/record-stripper.test.ts:132-188`.

Observed fact: for truncated-zone tool turns, it preserves calls/outputs but truncates `function_call.arguments` by parsing the JSON string and truncating long string values, and truncates `function_call_output.output` or `custom_tool_call_output.output` if string/ContentItem array. Evidence: `src/core/record-stripper.ts:121-155`, `src/core/record-stripper.ts:340-377`.

Observed fact: reasoning handling is global. `reasoningMode: "full"` removes `response_item` `reasoning`; `"summary-only"` preserves the record but deletes `content` and `encrypted_content`; `"none"` preserves it. `response_item` `compaction` is explicitly not treated as reasoning. Evidence: `src/core/record-stripper.ts:158-185`, tests in `test/core/record-stripper.test.ts:439-517`.

Observed fact: when tool stripping is active, cxs removes `event_msg` records unless their subtype is in the native replay preserve list or the configured preserve list. The native preserve list is `user_message`, `agent_message`, `agent_reasoning`, `agent_reasoning_raw_content`, `token_count`, `context_compacted`, `entered_review_mode`, `exited_review_mode`, `thread_rolled_back`, `undo_completed`, `turn_aborted`, `turn_started`, `turn_complete`; `item_completed` is preserved only for plan items. Evidence: `src/types/codex-session-types.ts:188-229`, `src/core/record-stripper.ts:187-203`, `test/core/record-stripper.test.ts:586-713`.

Observed fact: `turn_context` in removed/truncated zones is removed; `turn_context` in preserved zones is kept but non-structural instruction fields are stripped. Structural fields are `turn_id`, `cwd`, `model`, `effort`, `approval_policy`, `sandbox_policy`, `truncation_policy`, `personality`, `summary`, `current_date`, `timezone`, and `network`. Evidence: `src/core/record-stripper.ts:205-216`, `src/core/record-stripper.ts:408-415`, `src/types/codex-session-types.ts:145-186`, tests in `test/core/record-stripper.test.ts:717-789`.

Observed fact: top-level `compacted` records and `response_item` `compaction` are preserved. Evidence: `src/core/record-stripper.ts:474-479`, tests in `test/core/record-stripper.test.ts:840-880`.

Observed fact: `ghost_snapshot` is stripped when tool stripping is active. Evidence: `src/core/record-stripper.ts:218-225`, `test/core/record-stripper.test.ts:791-815`. Current Codex binary strings include "skipping legacy ghost_snapshot rollout line", suggesting this is legacy.

Observed fact: cxs removes "empty" removed-zone turns only if no `message` response item and no preserved event remains. Evidence: `src/core/record-stripper.ts:229-257`, `src/core/record-stripper.ts:417-472`, tests in `test/core/record-stripper.test.ts:294-437`.

Observed fact: compatibility guard requires at least one surviving `event_msg` `user_message`, or it synthesizes one immediately after the first surviving non-bootstrap user `response_item` message. If the source had user events and stripping removed all of them, it errors rather than guessing; if no text user message survives, it errors. Evidence: `src/core/clone-operation-executor.ts:214-333`, tests in `test/integration/clone-operation-executor.test.ts:532-772`, smoke test in `test/smoke/clone-smoke.test.ts:227-250`.

Observed fact: the project explicitly smoke-validates that `codex resume <new-id>` shows usable assistant back-history. Evidence: `smoke-tests/README.md:66-73`, manual pass log `smoke-tests/manifest/manual-smoke-log.md:17-25`, and clone smoke tests asserting preserved `agent_message`/`user_message` replay markers in `test/smoke/clone-smoke.test.ts:112-143`, `test/smoke/clone-smoke.test.ts:145-196`.

Inference: cxs-cloner's coherence model is conservative: model-visible `response_item` messages are likely enough for model context, but Codex's TUI/replay layer needs event messages (`user_message`, `agent_message`, etc.) to display usable back-history. This is why cxs preserves/synthesizes user events even when response items remain.

## Phase 2: observed rollout corpus

### Corpus counts and version drift

Observed fact: under `/Users/leemoore/.codex/sessions`, I found 3345 rollout files. Dates ranged from 2026-04-11 through 2026-07-07 in the active tree. Counts by top-level type across parsed active files:

| top-level type | count |
|---|---:|
| `response_item` | 453230 |
| `event_msg` | 271389 |
| `turn_context` | 15896 |
| `session_meta` | 11748 |
| `compacted` | 267 |

All parsed JSONL lines in this scan parsed successfully.

Observed fact: older April files from `codex-tui` 0.115.0/0.120.0 lack `session_meta.payload.session_id`; current 0.142.x files include it. Example older files:

| file | originator/source/version | `session_id` present |
|---|---|---|
| `~/.codex/sessions/2026/04/11/rollout-2026-04-11T18-40-05-019d7eb3-c9c9-7be0-9edf-9920bff15b94.jsonl` | `codex-tui` / `cli` / `0.115.0` | no |
| `~/.codex/sessions/2026/04/11/rollout-2026-04-11T19-32-44-019d7ee3-fe20-7cd2-928d-0492afd7191d.jsonl` | `codex-tui` / `cli` / `0.120.0` | no |
| `~/.codex/sessions/2026/04/12/rollout-2026-04-12T09-07-38-019d81ce-0e58-7de1-b7c9-c4c7d77e7f3b.jsonl` | `codex-tui` / `cli` / `0.120.0` | no |

Observed fact: recent July files include both interactive/Desktop (`originator: "Codex Desktop"`, `source: "vscode"`) and non-interactive exec (`originator: "codex_exec"`, `source: "exec"`). Examples:

| file | originator/source/version | counts |
|---|---|---|
| `~/.codex/sessions/2026/07/07/rollout-2026-07-07T07-09-02-019f3c44-62fa-7161-975a-3f456e028ff4.jsonl` | `codex_exec` / `exec` / `0.142.5` | 1 `session_meta`, 1 `turn_context`, 110 `response_item`, 22 `event_msg` |
| `~/.codex/sessions/2026/07/05/rollout-2026-07-05T19-05-09-019f3487-4b89-7ee3-b253-d26ada1e7447.jsonl` | `Codex Desktop` / `vscode` / `0.142.5` | 1 `session_meta`, 12 `turn_context`, 1431 `response_item`, 1039 `event_msg`, 2 `compacted` |
| `~/.codex/sessions/2026/07/06/rollout-2026-07-06T16-40-33-019f3929-4581-7051-92f6-53d20879afec.jsonl` | `Codex Desktop` / `vscode` / `0.142.5` | 8 `session_meta`, 6 `turn_context`, 207 `response_item`, 96 `event_msg` |

Observed fact: there are multiple resumed/forked/reconstructed files. 132 active rollout files contain more than one top-level `session_meta`. Some are fork chains: the first line is the active new session id with `forked_from_id`, and following lines are earlier source-session metadata/history. Example `~/.codex/sessions/2026/07/03/rollout-2026-07-03T09-11-35-019f28bf-f05d-7ed1-8bec-dcf70aaa3e29.jsonl` begins with active `id=session_id=019f28bf...`, `forked_from_id=019f2642...`, then line 2 is a `session_meta` for `019f2642...`, followed by that source history. This indicates fork/resume reconstruction can copy older history into a new file rather than only append to the old file.

Observed fact: some sessions append multiple turns in-place in a single rollout file. `~/.codex/sessions/2026/07/05/rollout-2026-07-05T19-05-09-019f3487-4b89-7ee3-b253-d26ada1e7447.jsonl` has repeated `event_msg` `task_started`/`task_complete` pairs and 12 `turn_context` records in one file. It also contains a `thread_rolled_back` event, then a new `task_started`, showing history is append-only with rollback represented by event records.

Observed fact: compaction appears as both a top-level `compacted` record and an adjacent `event_msg` `context_compacted`. In the July 5 file above, line 809 is top-level `compacted` with `replacement_history` length 7, `window_number`, `first_window_id`, `previous_window_id`, and `window_id`; line 812 is `event_msg` `context_compacted`. Later line 1875 is another `compacted` with replacement history length 14, followed by another `context_compacted`.

### File naming and id rules

Observed fact: every sampled active rollout filename matched:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
```

Observed fact: in all scanned active files, the filename UUID matched the first `session_meta.payload.id`. In 0.142.x current files, the first `session_meta.payload.session_id` also matched.

Observed fact: filename timestamp uses hyphens in the time portion (`T07-09-02`); line timestamps are RFC3339/ISO strings with milliseconds and `Z` (`2026-07-07T11:09:02.776Z`). The filename time is not necessarily the same timezone representation as line timestamps: for the July 7 file, filename `07-09-02` corresponds to line timestamp `11:09:02Z` in America/New_York.

Inference: synthetic files should follow the filename convention exactly and place the file under the date directory matching the local filename date. Codex likely uses filename parse for filesystem discovery and state-db reconciliation, as cxs does and as binary diagnostics mention "malformed file names".

### `session_meta` schema

Observed fields across active files:

| field | observed type(s) | notes |
|---|---|---|
| `id` | string | Present in all 11748 `session_meta` lines. Active id for the first line. |
| `session_id` | string | Present in 1904 recent/current metadata lines, including 0.142.x. Equals `id` in sampled current files. |
| `forked_from_id` | string | Present in 6694 metadata lines, especially fork/reconstructed histories. |
| `parent_thread_id` | string | Present in 35 lines, subagent-related. |
| `timestamp` | string | Present in all metadata lines. |
| `cwd` | string | Present in all metadata lines. |
| `originator` | string | Examples: `codex_exec`, `codex-tui`, `Codex Desktop`, `codex_vscode`, `t3code_desktop`. |
| `cli_version` | string | Examples: `0.115.0`, `0.120.0`, `0.142.5`. |
| `source` | string or object | Strings include `exec`, `cli`, `vscode`; object form used for subagent spawn source. |
| `thread_source` | string | Recent values: `user`, `subagent`. |
| `agent_nickname` | string | Subagent sessions. |
| `agent_role` | string | Subagent sessions. |
| `model_provider` | string | Observed `openai` in sampled/aggregated files. |
| `base_instructions` | object | Always present in the aggregate; object includes large `text`, redacted here. |
| `git` | object | Often present; fields include `commit_hash`, `branch`, `repository_url`; cxs also allows legacy `origin_url`. |
| `dynamic_tools` | array | Present in 6118 metadata lines; current Desktop sessions may contain large dynamic tool schema blobs. |
| `memory_mode` | string | Present in 8300 metadata lines. |
| `multi_agent_version` | string | Present in 2980 metadata lines. |

Example redacted current exec first line:

```json
{
  "timestamp": "2026-07-07T11:09:02.776Z",
  "type": "session_meta",
  "payload": {
    "session_id": "019f3c44-62fa-7161-975a-3f456e028ff4",
    "id": "019f3c44-62fa-7161-975a-3f456e028ff4",
    "timestamp": "2026-07-07T11:09:02.620Z",
    "cwd": "/Users/leemoore/code/.older/cxs-cloner",
    "originator": "codex_exec",
    "cli_version": "0.142.5",
    "source": "exec",
    "thread_source": "user",
    "model_provider": "openai",
    "base_instructions": {"text": "..."},
    "git": {"commit_hash": "...", "branch": "master", "repository_url": "..."}
  }
}
```

### `turn_context` schema

Observed fact: `turn_context` is written near the start of a turn, usually after `event_msg` `task_started` and bootstrap/developer/user response items in current files. Current line example sequence from the July 7 exec file:

1. `session_meta`
2. `event_msg` `task_started`
3. `response_item` `message` role `developer`
4. `response_item` `message` role `user`
5. `turn_context`
6. `response_item` `message` role `user`
7. `event_msg` `user_message`

Observed fields across active `turn_context` payloads:

| field | observed type(s) | notes |
|---|---|---|
| `turn_id` | string | Present in all 15896 records; used by current metadata passthrough fields and events. |
| `cwd` | string | Present in all. |
| `workspace_roots` | array | Recent/current. |
| `current_date` | string | Present in all observed aggregate. |
| `timezone` | string | Present in all observed aggregate. |
| `approval_policy` | string | Current value examples: `never`. Older cxs fixture type expected object, so this drift matters. |
| `sandbox_policy` | object | Current examples: `{ "type": "danger-full-access" }`. |
| `permission_profile` | object | Recent/current. |
| `file_system_sandbox_policy` | object | Older/variant field. |
| `model` | string | Current examples: `gpt-5.5`. |
| `effort` | string | Current examples: `high`. |
| `personality` | string | Current examples: `friendly`. |
| `summary` | string | Current examples: `auto`; cxs fixtures used `null`. |
| `truncation_policy` | object | Optional. |
| `developer_instructions` | string | Optional; can be large, redacted. |
| `user_instructions` | string | Optional; can be large, redacted. |
| `collaboration_mode` | object | Current includes `mode` and `settings`. |
| `realtime_active` | boolean | Recent/current. |
| `multi_agent_version` | string | Recent/current. |
| `comp_hash` | string | Recent/current. |
| `final_output_json_schema` | object | Optional. |

Inference: for a synthetic file, a minimal `turn_context` is probably not needed for already-completed historical messages to be model-visible, but it is useful for replay/UI boundaries and future app-server catalog extraction. Current Codex likely derives runtime configuration for a resumed turn mostly from CLI/config plus first `session_meta`, but cxs treats `turn_context` as the turn boundary and current files always have it for real turns.

### `response_item` subtypes and schemas

Observed response item subtype counts:

| subtype | count | notes |
|---|---:|---|
| `function_call` | 134615 | Tool call request; paired to output by `call_id`. |
| `function_call_output` | 134600 | Tool output; paired by `call_id`. Slight count mismatch exists corpus-wide. |
| `message` | 92547 | Roles observed include developer, user, assistant; content is an array of typed text/image items. |
| `reasoning` | 69532 | Summary plus encrypted content; often `content: null`. |
| `custom_tool_call` | 10439 | Paired to custom output by `call_id`. |
| `custom_tool_call_output` | 10439 | Paired by `call_id`. |
| `web_search_call` | 796 | Usually standalone; event `web_search_end` carries result-ish telemetry. |
| `tool_search_call` | 131 | Newer than cxs type list. |
| `tool_search_output` | 131 | Newer than cxs type list. |

Observed `message` shape:

```json
{
  "type": "message",
  "id": "msg_...",
  "role": "assistant",
  "content": [{"type": "output_text", "text": "..."}],
  "phase": "commentary",
  "metadata": {"turn_id": "..."},
  "internal_chat_message_metadata_passthrough": {"turn_id": "..."}
}
```

Field notes: `id`, `phase`, `metadata`, and `internal_chat_message_metadata_passthrough` are optional. In aggregate, only 11519 of 92547 message items had `id`; 56933 had `phase`; 7062 had `metadata`; 10168 had `internal_chat_message_metadata_passthrough`. Content item variants observed/declared by cxs are `input_text`, `input_image`, and `output_text`. Evidence for cxs types: `src/types/codex-session-types.ts:60-66`, `src/types/codex-session-types.ts:139-143`.

Observed `reasoning` shape:

```json
{
  "type": "reasoning",
  "id": "rs_...",
  "summary": [],
  "content": null,
  "encrypted_content": "...",
  "metadata": {"turn_id": "..."},
  "internal_chat_message_metadata_passthrough": {"turn_id": "..."}
}
```

Field notes: `summary` is always present in aggregate; `encrypted_content` is present in aggregate; `content` appeared as null in many older/current files; `id` is optional in corpus (6249 of 69532). cxs' type allowed `content` as text array and `encrypted_content` optional; current files often invert that practical importance. Evidence: `src/types/codex-session-types.ts:68-82`.

Observed `function_call` shape:

```json
{
  "type": "function_call",
  "id": "fc_...",
  "name": "exec_command",
  "arguments": "{\"cmd\":\"...\"}",
  "call_id": "call_...",
  "namespace": "functions",
  "metadata": {"turn_id": "..."},
  "internal_chat_message_metadata_passthrough": {"turn_id": "..."}
}
```

Field notes: `name`, JSON-string `arguments`, and `call_id` are present in all observed `function_call`; `id`, `namespace`, and metadata fields are optional. cxs preserves `call_id` when truncating and removes paired output by `call_id` when deleting. Evidence: `src/types/codex-session-types.ts:84-95`, `src/core/record-stripper.ts:88-117`.

Observed `function_call_output` shape:

```json
{
  "type": "function_call_output",
  "call_id": "call_...",
  "output": "...",
  "internal_chat_message_metadata_passthrough": {"turn_id": "..."}
}
```

Field notes: `output` can be string or ContentItem array; `call_id` links to the request. No `id` field was observed for outputs.

Observed `custom_tool_call` shape:

```json
{
  "type": "custom_tool_call",
  "id": "ctc_...",
  "status": "completed",
  "call_id": "call_...",
  "name": "...",
  "input": "...",
  "metadata": {"turn_id": "..."}
}
```

Observed `custom_tool_call_output` shape:

```json
{
  "type": "custom_tool_call_output",
  "call_id": "call_...",
  "output": "..."
}
```

Observed `web_search_call` shape:

```json
{
  "type": "web_search_call",
  "id": "ws_...",
  "status": "completed",
  "action": {"type": "search", "query": "...", "queries": ["..."]},
  "metadata": {"turn_id": "..."}
}
```

Observed `tool_search_call` shape, not known to cxs:

```json
{
  "type": "tool_search_call",
  "id": "...",
  "call_id": "call_...",
  "status": "...",
  "execution": "...",
  "arguments": {"query": "...", "limit": 8}
}
```

Observed `tool_search_output` shape, not known to cxs:

```json
{
  "type": "tool_search_output",
  "call_id": "call_...",
  "status": "...",
  "execution": "...",
  "tools": [{"type": "namespace", "name": "...", "tools": ["..."]}]
}
```

Observed fact: current corpus did not contain `local_shell_call` counts, but cxs supports it and the installed binary strings include `local_shell_call`. cxs' shape is `{type:"local_shell_call", call_id?, action, status}`. Evidence: `src/types/codex-session-types.ts:97-102`.

Inference: on resume, the model-visible conversation is rebuilt primarily from `response_item` history, with `message` items representing user/developer/assistant content, and tool calls/outputs included if preserved. `event_msg` duplicates some display text but is not the canonical model item stream. Evidence: cxs can strip most events and still smoke-resume with assistant back-history, while preserving message response items; cxs only treats event preservation as "replay" compatibility.

### `event_msg` subtypes and schemas

Observed event subtype counts:

| subtype | count |
|---|---:|
| `token_count` | 134238 |
| `agent_message` | 66271 |
| `user_message` | 21304 |
| `exec_command_end` | 14716 |
| `task_started` | 12864 |
| `task_complete` | 12373 |
| `patch_apply_end` | 5836 |
| `agent_reasoning` | 1239 |
| `web_search_end` | 568 |
| `turn_aborted` | 492 |
| `mcp_tool_call_end` | 400 |
| `context_compacted` | 266 |
| `collab_waiting_end` | 234 |
| `thread_rolled_back` | 148 |
| `thread_name_updated` | 138 |
| `collab_agent_spawn_end` | 121 |
| `collab_agent_interaction_end` | 73 |
| `collab_close_end` | 62 |
| `item_completed` | 23 |
| `error` | 9 |
| `collab_resume_end` | 6 |
| `dynamic_tool_call_request` | 3 |
| `dynamic_tool_call_response` | 3 |
| `thread_goal_updated` | 2 |

Observed key shapes:

| subtype | payload fields |
|---|---|
| `task_started` | `type`, `turn_id`, optional `started_at`, `model_context_window`, `collaboration_mode_kind` |
| `user_message` | `type`, `message`, arrays `images`, `local_images`, `text_elements`, optional `client_id` |
| `agent_message` | `type`, `message`, `phase`, usually `memory_citation: null` |
| `agent_reasoning` | `type`, `text` |
| `token_count` | `type`, `info` object/null, `rate_limits` object/null |
| `task_complete` | `type`, `turn_id`, `last_agent_message`, optional `completed_at`, `duration_ms`, `time_to_first_token_ms` |
| `exec_command_end` | `type`, `call_id`, `process_id`, `turn_id`, `command`, `cwd`, `parsed_cmd`, `source`, `stdout`, `stderr`, `aggregated_output`, `exit_code`, `duration`, `formatted_output`, `status` |
| `patch_apply_end` | `type`, `call_id`, `turn_id`, `stdout`, `stderr`, `success`, `changes`, `status` |
| `web_search_end` | `type`, `call_id`, `query`, `action` |
| `mcp_tool_call_end` | `type`, `call_id`, `invocation`, `duration`, `result`, optional `plugin_id` |
| `turn_aborted` | `type`, `turn_id`, `reason`, optional `completed_at`, `duration_ms` |
| `thread_rolled_back` | `type`, `num_turns` |
| `context_compacted` | `type` only in observed aggregate |
| `thread_name_updated` | `type`, `thread_id`, `thread_name` |
| `item_completed` | `type`, `thread_id`, `turn_id`, `item` |
| `collab_agent_spawn_end` | `type`, `call_id`, `sender_thread_id`, `new_thread_id`, `new_agent_nickname`, `new_agent_role`, `prompt`, `model`, `reasoning_effort`, `status` |
| `collab_waiting_end` | `type`, `sender_thread_id`, `call_id`, `statuses`, optional `agent_statuses` |
| `collab_agent_interaction_end` | `type`, `call_id`, `sender_thread_id`, `receiver_thread_id`, `receiver_agent_nickname`, `receiver_agent_role`, `prompt`, `status` |
| `collab_close_end` | `type`, `call_id`, `sender_thread_id`, `receiver_thread_id`, `receiver_agent_nickname`, `receiver_agent_role`, `status` |
| `collab_resume_end` | `type`, `call_id`, `sender_thread_id`, `receiver_thread_id`, `receiver_agent_nickname`, `receiver_agent_role`, `status` |
| `dynamic_tool_call_request` | `type`, `callId`, `turnId`, `namespace`, `tool`, `arguments` |
| `dynamic_tool_call_response` | `type`, `call_id`, `turn_id`, `namespace`, `tool`, `arguments`, `content_items`, `success`, `error`, `duration` |
| `error` | `type`, `message`, `codex_error_info` |
| `thread_goal_updated` | `type`, `threadId`, `goal` |

Inference: event messages are mostly display/replay/catalog telemetry, not required model input. Load-bearing exceptions for synthetic resume compatibility:

- `user_message` appears important for replay/list extraction and cxs compatibility.
- `agent_message` is useful for visible transcript/back-history in the TUI.
- `context_compacted`, `thread_rolled_back`, `turn_aborted`, and plan `item_completed` are important if you want UI state/replay semantics to match the source, but likely not required for simple model continuation.
- `token_count`, tool-end telemetry, rate limits, timings, and stdout/stderr-rich event messages are not needed for model context if corresponding `response_item` tool outputs are preserved or intentionally stripped.

### `compacted` schema

Observed top-level `compacted` payload fields:

| field | type | notes |
|---|---|---|
| `message` | string | Human/system compaction message. |
| `replacement_history` | array | Present in all 267 observed; contains response-item-like history replacing prior context. |
| `window_number` | number | Present in 72 observed. |
| `first_window_id` | string | Present in 52 observed. |
| `previous_window_id` | string | Present in 52 observed. |
| `window_id` | string | Present in 72 observed. |

Observed fact: cxs preserves top-level `compacted` and treats the last top-level compaction as a boundary for tool stripping. Evidence: `src/core/turn-boundary-calculator.ts:32-45`, `src/core/record-stripper.ts:474-479`.

Inference: for a synthetic reconstructed history, avoid inventing `compacted` unless you understand `replacement_history` semantics. It is safe to omit compaction records and instead provide the already-reconstructed message history, unless you need to represent an actual Codex compaction event/UI state.

### `session_index.jsonl`, `history.jsonl`, and sqlite

Observed fact: `/Users/leemoore/.codex/session_index.jsonl` had 453 lines. Each sampled line is:

```json
{"id":"<session-id>","thread_name":"...","updated_at":"2026-07-06T20:41:36.551881Z"}
```

Observed fact: `/Users/leemoore/.codex/history.jsonl` had 936 lines. Each sampled line is:

```json
{"session_id":"<session-id>","ts":1782386961,"text":"..."}
```

Observed fact: `history.jsonl` stores prompt/search history text, not rollout paths. cxs never reads or writes it.

Observed fact: current Codex state db `/Users/leemoore/.codex/state_5.sqlite` has table `threads`:

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  sandbox_policy TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  has_user_event INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  git_sha TEXT,
  git_branch TEXT,
  git_origin_url TEXT,
  cli_version TEXT NOT NULL DEFAULT '',
  first_user_message TEXT NOT NULL DEFAULT '',
  agent_nickname TEXT,
  agent_role TEXT,
  memory_mode TEXT NOT NULL DEFAULT 'enabled',
  model TEXT,
  reasoning_effort TEXT,
  agent_path TEXT,
  created_at_ms INTEGER,
  updated_at_ms INTEGER,
  thread_source TEXT,
  preview TEXT NOT NULL DEFAULT '',
  recency_at INTEGER NOT NULL DEFAULT 0,
  recency_at_ms INTEGER NOT NULL DEFAULT 0
);
```

Observed fact: it also has `thread_spawn_edges(parent_thread_id, child_thread_id, status)` and `thread_dynamic_tools(thread_id, position, name, description, input_schema, defer_loading, namespace)`.

Observed fact: the state db had 3345 `threads` rows, and the active filesystem scan found 3345 active rollout files. Only one db row was archived. Recent rows include `rollout_path`, `source`, `cwd`, `cli_version`, `thread_source`, and non-empty title/preview. The `has_user_event` column was 0 for all rows in this local db despite rollout files containing `event_msg.user_message`, so this column is not reliable as a simple "contains user event" indicator in this installation.

Observed fact: the installed native binary contains diagnostics and module paths indicating a rollout db/backfill pipeline, including `rollout/src/state_db.rs`, `rollout/src/list.rs`, `rollout/src/session_index.rs`, "state DB missing while rollout files exist", "state DB contains matching thread rows", "state DB is missing while rollout files exist", "Start Codex with no state DB present so startup backfill can create it from rollout files", "no parseable rollout items", "empty session file", and resume-related `tui/src/resume_picker.rs`/`tui/src/session_resume.rs`.

Inference: `codex resume` in 0.142.5 likely uses the app server/state db for picker, `--last`, and fast id lookup, but the state db is derived from rollout files and can be backfilled/reconciled. A file-only clone can still become discoverable after Codex backfill/restart, which matches cxs smoke documentation. Immediate visibility in a currently running Codex app may require either triggering Codex's own reconciliation or writing/upserting sqlite consistently, which cxs does not do.

## Phase 3: answers for synthetic resume

### 1. Minimal lines/fields for `codex resume <id>`

Observed fact from cxs: a "minimal session (just session_meta + one message)" clone succeeds in cxs tests. Evidence: `test/integration/clone-operation-executor.test.ts:937-954`. However, this is a cxs unit/integration assertion, not a direct current 0.142.5 resume invocation.

Observed fact from cxs smoke/manual docs: real clones with preserved/synthesized replay events can be resumed and show assistant back-history. Evidence: `smoke-tests/README.md:66-73`, `smoke-tests/manifest/manual-smoke-log.md:17-25`.

Best-evidence minimal synthetic file:

```jsonl
{"timestamp":"<now-z>","type":"session_meta","payload":{"session_id":"<new-id>","id":"<new-id>","timestamp":"<now-z>","cwd":"<cwd>","originator":"codex_exec","cli_version":"0.142.5","source":"exec","thread_source":"user","model_provider":"openai","base_instructions":{"text":"..."}}}
{"timestamp":"<turn-start-z>","type":"event_msg","payload":{"type":"task_started","turn_id":"<turn-id>","started_at":<unix-seconds>,"model_context_window":258400,"collaboration_mode_kind":"default"}}
{"timestamp":"<turn-start-z>","type":"turn_context","payload":{"turn_id":"<turn-id>","cwd":"<cwd>","workspace_roots":["<cwd>"],"current_date":"YYYY-MM-DD","timezone":"America/New_York","approval_policy":"never","sandbox_policy":{"type":"danger-full-access"},"model":"gpt-5.5","personality":"friendly","effort":"high","summary":"auto"}}
{"timestamp":"<t1-z>","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}],"internal_chat_message_metadata_passthrough":{"turn_id":"<turn-id>"}}}
{"timestamp":"<t1-z>","type":"event_msg","payload":{"type":"user_message","message":"...","images":[],"local_images":[],"text_elements":[]}}
{"timestamp":"<t2-z>","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"..."}],"phase":"final_answer","internal_chat_message_metadata_passthrough":{"turn_id":"<turn-id>"}}}
{"timestamp":"<t2-z>","type":"event_msg","payload":{"type":"agent_message","message":"...","phase":"final_answer","memory_citation":null}}
{"timestamp":"<t2-z>","type":"event_msg","payload":{"type":"task_complete","turn_id":"<turn-id>","last_agent_message":"...","completed_at":<unix-seconds>,"duration_ms":1}}
```

Strict minimum for model context is probably line 1 plus `response_item` `message` items. Practical minimum for Codex UI/resume cleanliness is line 1 plus user/assistant `response_item.message` lines plus at least one `event_msg.user_message`. The extra `turn_context` and task events make the file look native, improve catalog/replay extraction, and give a wrapper stable turn boundaries.

Important current-format fields to set:

- `session_meta.payload.id` and `session_meta.payload.session_id` must equal the filename UUID.
- `session_meta.payload.timestamp` should be close to line 1 `timestamp`.
- `session_meta.payload.cwd` should exist and be a real cwd if commands will continue there.
- `session_meta.payload.originator/source/thread_source` should be plausible: `codex_exec`/`exec`/`user` for non-interactive synthetic files or `Codex Desktop`/`vscode`/`user` for Desktop-style files.
- Include `base_instructions.text`. It appears in all observed metadata lines. If omitted, Codex may fall back to current defaults, but that was not proven.

### 2. What feeds in-memory conversation on resume

Observed fact: live rollout files duplicate transcript content in two layers:

- Canonical model item stream: `response_item` with `message`, `reasoning`, tool calls, and tool outputs.
- UI/event stream: `event_msg` with `user_message`, `agent_message`, `agent_reasoning`, token counts, task lifecycle, tool-end telemetry, etc.

Observed fact: cxs removes many `event_msg` subtypes and can still produce resumable clones; it preserves/synthesizes selected replay events. Evidence: `src/core/record-stripper.ts:187-203`, `src/types/codex-session-types.ts:194-229`, `test/smoke/clone-smoke.test.ts:145-196`.

Inference: model context on resume is rebuilt primarily from `response_item` payloads, including `message` and, if retained, function/tool call pairs. `event_msg` appears mostly ignored for model context but important for TUI transcript replay, title/preview/catalog extraction, and state changes such as compaction/rollback display.

Inference: `turn_context` likely informs turn boundaries and stored settings, but current Codex can probably start a new turn from `session_meta` plus current CLI config. Because every native current turn has a `turn_context`, synthetic files should include it.

Inference: top-level `compacted.replacement_history` is likely used by Codex reconstruction after compaction, because it explicitly stores replacement history. If synthesizing already-expanded history, omit compaction rather than inventing it.

### 3. Coherence rules

Observed/inferred rules:

- Filename UUID, first `session_meta.payload.id`, and current `session_meta.payload.session_id` should match.
- First line should be `session_meta`. cxs assumes Codex writes it first and reads first 100 lines for metadata. Evidence: `src/io/session-file-reader.ts:31-35`, `src/io/session-file-reader.ts:165-167`.
- Every line must be valid JSON and have `timestamp`, `type`, `payload`. Evidence: `src/io/session-file-reader.ts:320-330`, `test/integration/clone-operation-executor.test.ts:201-223`.
- Preserve chronological/order coherence, but exact timestamps need not be strictly unique. Current files often have several adjacent records with identical millisecond timestamps.
- `function_call` and `function_call_output` pair by `call_id`; do not leave an output for a removed call unless intentionally preserving tool result context. cxs removes both together. Evidence: `src/core/record-stripper.ts:88-117`.
- `custom_tool_call` and `custom_tool_call_output` pair by `call_id`; same rule.
- `web_search_call` is standalone at the response-item layer, but `event_msg.web_search_end.call_id` may link to it if present.
- `tool_search_call`/`tool_search_output` pair by `call_id`; cxs does not know these current subtypes, so a new wrapper must.
- `response_item.id` (`msg_...`, `fc_...`, `rs_...`) is optional in the corpus. Do not fabricate unless useful; if preserving source records, keep ids as-is.
- `turn_id` links `task_started`, `turn_context`, many current response-item metadata objects, `task_complete`, and tool event telemetry. If synthesizing, use one fresh `turn_id` per turn and keep it consistent.
- Do not renumber/relink existing ids unless changing the logical relationship. cxs does not renumber response items or call ids; it only removes/truncates records.
- Preserve or synthesize at least one `event_msg.user_message` with text if you want resume/back-history compatibility similar to cxs.
- If representing rollback, preserve `thread_rolled_back` and append new records; do not delete old records unless building a fresh reconstructed rollout.
- If representing compaction, preserve `compacted` plus `event_msg.context_compacted`; otherwise omit both.

### 4. What must be registered outside the rollout

Observed fact: cxs only writes rollout plus optional `session_index.jsonl`, and smoke docs say the clone should appear in cxs filesystem listing, Codex app after refresh/restart, and `codex resume <new-id>`. Evidence: `smoke-tests/README.md:66-71`.

Observed fact: current Codex has a sqlite `threads` catalog keyed by id and rollout path. The native binary contains rollout db/backfill/reconcile diagnostics. The local db row count matched active rollout file count.

Best-evidence answer:

- For file-based eventual discovery: a correctly named rollout file under `~/.codex/sessions/YYYY/MM/DD/` is the core registration.
- For a friendly name: append `~/.codex/session_index.jsonl` with `{id, thread_name, updated_at}`. It helps naming and older flows; cxs does this. Current sqlite `threads.title` may supersede it after backfill.
- For prompt shell history: `history.jsonl` is not required for resume lookup.
- For immediate current 0.142.5 picker/`--last`: sqlite `state_5.sqlite.threads` is likely consulted first by the app server/TUI. If the app server is already running, a new file may not appear until the state db reconciliation/backfill runs. Writing sqlite by hand is possible but risky because the db also has dynamic tools, spawn edges, archive state, previews, and recency triggers.
- Explicit `codex resume <id>`: help says `SESSION_ID` may be a UUID or session name and UUIDs take precedence. Binary strings include "no rollout found for thread id" and "state db returned rollout path for thread", suggesting explicit id is resolved through the state db when available, with filesystem fallback/reconcile. This was not directly tested by creating a new synthetic file because the mission prohibited writing outside the report.
- `codex resume --last`: help says it picks the most recent recorded session and by default excludes non-interactive unless `--include-non-interactive` is passed. Therefore `--last` likely keys off state db recency (`updated_at_ms`/`recency_at_ms`) and filters `source`/cwd/archive flags.
- Picker: likely keys off state db `threads`, current cwd unless `--all`, archive flag, and source/non-interactive filters.

### 5. Known risks and cxs vs 0.142.5 drift

Observed drift:

- Current `session_meta` has `session_id`; cxs only rewrites `id`.
- Current response items may have `id`, `metadata`, and `internal_chat_message_metadata_passthrough`; cxs types do not model all current fields but preserve unknown keys by structured clone.
- Current response item subtypes include `tool_search_call` and `tool_search_output`; cxs does not list or strip them.
- The installed binary strings include `image_generation_call`, `image_generation_begin`, `image_generation_end`, `raw_response_item`, `item_started`, `hook_started`, `hook_completed`, `plan_update`, deltas, approval requests, and more event types not present in cxs' known type list.
- Current `turn_context.approval_policy` is a string in observed files; cxs types expect `unknown`, fixtures use an object.
- Current `turn_context.summary` is often string `auto`; cxs fixtures use `null`.
- Current Codex uses sqlite state; cxs does not update it.
- Current Codex supports `--include-non-interactive`; picker/last behavior may exclude `source: exec` sessions by default.
- Current rollouts can contain multiple top-level `session_meta` records as copied history in fork/reconstructed files. cxs updates only the first `session_meta`, which is correct for the active identity but means older copied metadata remains embedded.
- Current files may include very large `dynamic_tools` in `session_meta`; synthesizing these is probably unnecessary for simple resume but may affect app/plugin tool availability display.

Risk guidance:

- Preserve unknown records and unknown fields by default.
- When stripping, only strip subtypes you intentionally understand.
- For synthetic minimal files, prefer message-only history over partially preserved unmatched tool calls.
- If preserving tool calls, keep request/output pairs adjacent or at least ordered request before output with identical `call_id`.
- Set both `id` and `session_id` in first metadata.
- Consider appending `session_index.jsonl`, but avoid manual sqlite writes unless you fully replicate Codex's db extraction logic or can trigger Codex's own reconciliation.

## Unknowns and open questions

- I did not create a test synthetic rollout and run `codex resume <id>` because the mission allowed writing only this report.
- I could not inspect Rust source for `rollout_reconstruction` or `session_resume`; the installed package contains a native binary only. Binary strings provide module/diagnostic names but not exact control flow.
- The exact minimal set accepted by `codex resume <id>` in 0.142.5 may be smaller than the practical minimum recommended here.
- The exact sqlite-vs-filesystem precedence for explicit id lookup, picker, and `--last` was inferred from schemas, binary diagnostics, cxs behavior, and help text, not proven with a fresh synthetic file.
- The role of `base_instructions.text` in accepting a resume is unknown; it appears in all observed `session_meta` records, so omitting it is risky.
- The role of `dynamic_tools` on resume is unknown; it may be ignored for simple continuation or needed for app-supplied tools in Desktop-originated sessions.
- The exact semantics of top-level `compacted.replacement_history` and current `window_id` fields require source-level confirmation.
- `has_user_event` in `state_5.sqlite.threads` was 0 for all local rows, contradicting a naive interpretation of the column name.
- Current files may contain event/response subtypes not present in this local corpus but supported by the binary (`image_generation_*`, approval events, hook events, raw/delta events).
- It remains unknown whether current Codex validates `session_meta.cli_version`, `model_provider`, `source`, or `thread_source` beyond extraction/cataloging.
