# Long Horizon Context (LHC)

Long Horizon Context (LHC) is a durable context-management system for AI
agents. Long-running conversations eventually outgrow a model's context
window. A conventional compact replaces the older conversation with one lossy
summary. Repeating that process creates a context cliff: detail disappears and
the agent cannot recover it.

LHC keeps an append-only **canonical event record**. It serves a rebuildable
**fidelity ramp** over that record: recent work stays full, then older work
moves through smooth, detailed, and brief bands. The working context becomes
smaller without making the underlying conversation unreachable.

Served history remains addressable. Turns and messages carry stable ids such as
`t211` and `m3177`. Bounded retrieval operations let an agent pull a labeled
turn rendering or a verbatim message back into working context, with slicing
receipts when an item is larger than the retrieval budget.

## Architecture

```text
host events
    |
    v
append-only canonical event record
    |
    +--> messages and agentic turns
    |        |
    |        +--> derivations and chunks
    |                  |
    |                  v
    |          compacted thread view
    |          brief -> detailed -> smooth -> full tail
    |
    +--> stable tN/mN retrieval
             |
             v
       recalled history + impression log
```

The main boundaries are deliberate:

- The canonical event record is append-only.
- Messages, turns, chunks, derivations, views, and host session files are
  projections or renderings. They can be rebuilt.
- TypeScript is the contract source.
- The host owns event capture, storage location, lifecycle, model access, and
  context injection.
- LHC does not call a model or network service directly. The host supplies the
  inference function.
- LHC prefers explicit degradation and visible gaps over silent omission.

An **agentic turn** begins with a user prompt and ends with the final assistant
response. It can contain multiple **model turns**, where each model turn is one
model request and response cycle.

## Implementations

| Implementation | Role | Current status |
| --- | --- | --- |
| [`lhc`](packages/lhc) | TypeScript SDK and contract source | Repository SDK and contract source; not published as a standalone registry package |
| [`lhc-rs`](packages/lhc-rs) | Host-agnostic Rust port | Certified against the TypeScript contract; consumed by the Codex and Grok forks |
| [`lhc-py`](packages/lhc-py) | Python port | Certified against the TypeScript contract; consumed by Hermes |
| [`lhc-convex`](packages/lhc-convex) | Convex implementation | Released through the current tagging and retrieval wave; downstream propagation continues independently |

Port certification proves the contract surface owned by that port. It does not
imply that every implementation is published to a package registry or already
contains every later feature from another port.

## Host integrations

| Host | Integration | Distribution |
| --- | --- | --- |
| [PI](https://github.com/earendil-works/pi) | [`pi-lhc`](packages/pi-lhc), the reference extension integration | Built from this repository |
| Codex CLI | Native Rust integration in the maintained [`codex-lhc`](https://github.com/liminal-ai/codex-lhc) fork | Fork release |
| Grok Build | Native Rust integration in the maintained [`grok-build-lhc`](https://github.com/liminal-ai/grok-build-lhc) fork | Fork release |
| Claude Code | [`cc-lhc`](packages/cc-lhc), a closed-host PTY wrapper | Public npm package and GitHub bundles |
| Hermes Agent | Native Python integration in the maintained [`hermes-lhc`](https://github.com/liminal-ai/hermes-lhc) fork using `context.engine: lhc` | Fork installation |
| t3code | Native integration in the external maintained [`liminal-ai/t3code`](https://github.com/liminal-ai/t3code) fork | External fork; [`packages/t3code-lhc`](packages/t3code-lhc) contains documentation only |

Hosts do not have identical capabilities. The integration surface determines
how each host captures events, exposes retrieval, and replaces its working
context. See [host integrations](docs/host-integrations.md) for the capability
and maintenance boundaries.

## Install cc-lhc

`cc-lhc` is the public end-user package in this repository. It wraps an
installed Claude Code CLI, captures its rollout into LHC, exposes retrieval
through the same `cc-lhc` command, and performs controlled context handoffs.

Prerequisites:

- Node.js 24.3 or later.
- An installed and authenticated Claude Code CLI.
- Linux, macOS, or native Windows on x64 or ARM64.

### npm

```sh
npm install --global cc-lhc
cc-lhc --lhc-help
```

Update an npm-owned installation with:

```sh
npm install --global cc-lhc@latest
```

### Complete GitHub bundles

These installers download a checksum-verified runtime bundle for the detected
platform. They do not invoke npm or a native compiler on the client.

Linux or macOS:

```sh
curl -fsSL https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.0/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/liminal-ai/long-horizon-context/releases/download/cc-lhc-v0.4.0/install.ps1 | iex
```

Update a script-owned installation by running the installer from the desired
new release. The installer replaces its managed runtime and preserves LHC
state. Do not mix npm-owned and script-owned installations without first
removing the old launcher; otherwise two `cc-lhc` commands can exist on
`PATH`.

Release assets and checksums are on the
[`cc-lhc-v0.4.0` release](https://github.com/liminal-ai/long-horizon-context/releases/tag/cc-lhc-v0.4.0).

### Use

Run Claude Code through the wrapper:

```sh
cc-lhc
```

The same executable provides one-shot retrieval operations while an
interactive wrapper process can remain active:

```sh
cc-lhc get-turns t211
cc-lhc get-messages m3177
```

Press `ctrl-]` in the interactive wrapper to open the LHC control panel.
Automatic compact uses provider-reported context usage for its trigger and LHC
rendered-token accounting for its target. Controlled handoffs preserve the
latest confirmed Claude effort and permission mode.

Claude Code is closed source, so cc-lhc keeps explicit boundaries. In-app
`/resume` is not a safe LHC continuation path. Use `cc-lhc --resume` or
`cc-lhc --continue`. Rebuilt session files omit signed thinking when exact
stored and live request identity cannot be proven.

The retained whole-product certification evidence is for Claude Code 2.1.226.
It is evidence for that artifact, not a guarantee for every future Claude Code
release. See the [cc-lhc README](packages/cc-lhc/README.md) for current policy,
recovery, configuration, verification, and compatibility details.

## Use the TypeScript SDK

The TypeScript SDK is a repository package, not a published standalone npm
package. Its public entry point is `initLhc(config)`. The returned object
contains these domains:

- `threads`
- `intakeStream`
- `messages`
- `turns`
- `retrieval`
- `threadView`
- `inspect`
- `logging`
- `work`

The host supplies a `ModelCall` function or the four inference callbacks. All
thread state is stored in per-thread SQLite files through `node:sqlite`.

See the [SDK README](packages/lhc/README.md) for initialization, types, domain
operations, derivation behavior, retrieval receipts, smart compact, prune, and
the durable work queue.

## Build from source

The workspace development floor is Node.js 24.17 or later with pnpm 11.8.0.
This is higher than the packaged cc-lhc runtime floor because the complete
workspace also builds the SDK, ports, tests, and vendored PI integration.

```sh
git clone --recursive https://github.com/liminal-ai/long-horizon-context.git
cd long-horizon-context
cd vendor/pi && npm ci && npm run build && cd ../..
pnpm install --frozen-lockfile
pnpm build
```

Useful verification commands:

```sh
pnpm --config.verify-deps-before-run=false --filter lhc run verify
pnpm --config.verify-deps-before-run=false --filter pi-lhc run verify
pnpm --config.verify-deps-before-run=false --filter cc-lhc run verify
```

To install a source checkout for one host, follow the ordered setup guide:

- [cc-lhc standalone setup](.setup/cc-lhc-standalone.md)
- [pi-lhc standalone setup](.setup/pi-lhc-standalone.md)

The PI setup builds the stock vendored PI submodule before it builds `pi-lhc`.
The cc-lhc standalone setup does not build PI.

## Core concepts

- **Canonical event record** — Host events stored in order as the durable
  source of truth.
- **Message** — A readable projection of one captured event, with typed blocks
  and a token estimate.
- **Agentic turn** — One user prompt through the final assistant response.
- **Derivation** — A deterministic or model-produced representation of source
  content. Derivations are versioned and rebuildable.
- **Chunk** — Consecutive closed agentic turns grouped for historical
  compression.
- **Thread view** — Stored compacted bands plus the recent full tail served to
  a model.
- **Smart compact** — Selection and rendering of a new thread view under a
  target budget.
- **Visibility boundary** — The point behind which old tool results render in
  shortened form while their canonical content remains available.
- **Stable address** — A `tN` turn id or `mN` message id visible in served
  history.
- **Retrieval** — Bounded drill-down by stable address. `getTurns` serves
  labeled turn renderings. `getMessages` serves verbatim message content.
- **Impression** — A durable record of a retrieval request and its served or
  unserved result.

## Documentation

- [Core concepts](docs/onboard/01-core-concepts.md)
- [Domain design](docs/onboard/02-domain-design.md)
- [Decision brief](docs/onboard/03-decisions-brief.md)
- [PI host](docs/onboard/04-host-pi-lhc.md)
- [cc-lhc host](docs/onboard/05-host-cc-lhc.md)
- [Host integrations and fork maintenance](docs/host-integrations.md)
- [Project lexicon](docs/lexicon.md)
- [Decision registry](docs/decision-registry.md)
- [Ethical framework](docs/ethical-framework.md)

## License

This repository is licensed under the [MIT License](LICENSE).
