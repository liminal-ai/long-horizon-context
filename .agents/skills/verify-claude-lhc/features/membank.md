# Membank tools

## Sub-features

- Membase at start: `lhc.membase: { socketPath }` in the start frame goes to
  `initLhc`, which calls membase's `Health`. A failed handshake ends the
  start with one `error` frame, `initLhc: membase handshake failed
  (<code>): <reason>`, before any store is created.
- Tool registration: with `lhc.membase` set, the `lhc` MCP server lists
  `get_turns`, `get_messages`, `membank_list` and `membank_get`, whether or
  not the thread is attached. Without it, only the first two. The tools are
  on `allowedTools` and the sidecar allows them itself, so no `canUseTool`
  request reaches the host.
- `membank_list { kind? }`: one `<id>  <title>  <description>` line per item
  of the attached bank.
- `membank_get { id }`: the item's fields and body inside a
  `<membank-item id="<id>">` envelope.
- Unattached thread: both tools answer exactly
  `this thread is not attached to a membank`.
- Timing: each call logs `<tool> <kind, all, or id> answered in <ms> ms` to
  stderr.

## How to get to it (user POV)

A host passes `lhc: { home, compact, membase: { socketPath } }` to `query()`
or in the `start` frame, then attaches the thread with
`membase attach --thread <thread id> --bank <bank>`, using the id from the
`created thread <id>` log line. The agent sees the two tools in its tool
list and calls them like any MCP tool.

## Driving it with the harness

- `drive.mjs membank-unreachable` needs nothing beyond the build.
- `MEMBASE_REPO=<installed membase checkout> drive.mjs membank-tools` boots
  its own membase lane. Without `MEMBASE_REPO` it checks only the tool list
  without membase.
- `CLAUDE_LHC_LIVE=1 MEMBASE_REPO=<checkout> drive.mjs membank-live` runs
  two real turns, one on an attached thread and one on an unattached thread.
  It costs two short model turns per run.

Install membase first per its `verify-membase` skill
(`scripts/offline-install.sh`), because the drives call its `lane.sh` and
`pnpm exec membase` from `MEMBASE_REPO`.

## Gotchas

- `mcpServerStatus` answers `[]` until the generation's CLI is up, so the
  drives wait for the `context window` log line before reading it.
- The CLI's `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]` warning on stderr lists the
  `lhc` tools. It is expected, because they are on `allowedTools` on
  purpose.
- Each membase lane is its own Convex container and service. The drive
  stops them with `lane.sh down`, which removes only that lane's container
  and pid.
