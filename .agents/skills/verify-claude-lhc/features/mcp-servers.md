# MCP servers

## Sub-features

- Servers in the start frame's `mcpServers` reach Claude Code with the
  `lhc` retrieval server beside them. Trunk and head serve the same tools.
- A `req` with method `setMcpServers` and params `{ servers }` replaces the
  servers added after start on the live generation, mid-turn included. The
  `res` value is the SDK's `{ added, removed, errors }`.
- Start-frame servers stay. On CLI 2.1.310 `Query.setMcpServers` only
  touches servers added after start, and the sidecar keeps that rule.
- `lhc` joins every set under its own name. A host server named `lhc` is
  dropped, as it is at start. Without the merge, a set would remove
  retrieval.
- The latest set carries into every generation the sidecar opens after a
  compact or a rollback start.

## How to get to it (user POV)

The v2 T3 Claude driver opens a query with no MCP servers and calls
`setMcpServers` right after. On a claude-lhc instance that call becomes the
`setMcpServers` request. The next turn sees the T3 tools and the LHC
retrieval tools. Before U12 the sidecar answered
`unknown control setMcpServers` and the turn had retrieval only.

## Driving it with the harness

```sh
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs start-mcp
CLAUDE_LHC_LIVE=1 .agents/skills/verify-claude-lhc/drive.mjs late-mcp
```

Both drives serve a one-tool MCP server over HTTP from the harness
process, so the drive owns it. `start-mcp` puts it in the start frame,
takes one real turn, and writes the turn's `mcp__` tools to `tools.json`.
Run it at head and with `CLAUDE_LHC_SIDECAR` at trunk, then diff the two
`tools.json` files. `late-mcp` starts with one start-frame server, sends
`setMcpServers` before the start log line (the v2 order), takes a turn, and
passes when the turn lists the start tool, `mcp__late__ping`, and both
retrieval tools. It compacts and checks the new generation lists the same
tools. A second set then replaces `late` with `other` and must not remove
`start` or `lhc`.

## Gotchas

- Tools come from the turn's `system/init` message, so both drives need a
  real model turn and sit behind `CLAUDE_LHC_LIVE=1`.
- The first set after start waits behind `start` and the CLI's own
  initialize, about 1.1 s. A set on a warm session takes about 12 ms, with
  the CLI round trip and the MCP handshake as the limit.
- At trunk, `late-mcp` fails with `setMcpServers refused: unknown control
  setMcpServers`. That is the regression evidence, not a harness fault.
