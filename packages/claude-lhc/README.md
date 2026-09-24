# claude-lhc

Claude Code sidecar for t3code's LHC provider instance. Runs the Claude Agent SDK (pinned 0.3.170,
the version t3code installs) against the Claude Code binary t3code points it at, records every
native message into an LHC thread as the primary record, and forwards the raw SDK stream to the
driver unchanged over JSONL stdio. The native session is a projection of the LHC served view: every
restart and every compact mints a fresh native session id from that view.

- `src/protocol.ts` — the wire: `start`, `user`, `req`/`res`, `abort`, `msg`, `error`.
- `src/session.ts` — generations, capture-before-forward, manual/auto compact, projection swap.
- `src/capture/mapper.ts` — SDK messages → LHC intake events (cc-lhc's rules on the wire shapes).
- `src/projection/project.ts` — LHC served view → native transcript lines.
- `src/nativeSessionFile.ts` — write those lines into the effective Claude home (`projects/<key>/<uuid>.jsonl`) before `query({resume})`. No `sessionStore`.
- `src/lhcHome.ts` — host `t3code-lhc`: `~/.t3code-lhc` (`T3CODE_LHC_HOME`), aliases `t3code-lhc:<session id>`.
- `src/inference/claudeCli.ts` — derivations through `claude -p --no-session-persistence`.
- `bin/claude-lhc` — convenience wrapper (`exec node dist/sidecar.js`). T3 spawns `process.execPath` with the compiled JS entry.

## Install

t3code-lhc installs the sidecar from npm; nothing in this repo needs building:

```sh
npm install claude-lhc@0.1.1
```

Point t3code at the compiled entry with `CLAUDE_LHC_SIDECAR=<prefix>/node_modules/claude-lhc/dist/sidecar.js`
(t3code-lhc's setup script does this). Node 24.3 or later. The package bundles the `lhc` core; it
is not published separately.

## Configuration

- **Claude home:** the same login and settings as Claude Code (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
- **LHC home:** `~/.t3code-lhc`, or `T3CODE_LHC_HOME`.
- **Compact settings** (the t3code Claude LHC instance form; both required, provider-billed tokens):
  `autoCompactWindow` (compact trigger) and `lhcLowerBound` (rebuilt view size), with the lower bound
  below the trigger.
- **`T3CODE_LHC_NO_INFERENCE=1`:** skip summary derivations (tests and previews).
- **`T3CODE_THREAD_ID`:** set by the t3code driver and passed through to Claude Code, so `lhc-agent`
  in a seat resolves its sender without `--from`.

## Build from source

Build (required; `dist/` is not in git):

```sh
pnpm --filter lhc build && pnpm --filter claude-lhc build
```

Then run `node packages/claude-lhc/dist/sidecar.js` (or `node packages/claude-lhc/bin/claude-lhc.js`). Bun is not used.

## Thinking replay after compact

The projected session replays the tail's thinking blocks with their signatures
(`SELECTED_THINKING_REBUILD_ARM` in `src/projection/project.ts`, mirroring cc-lhc).
The API binds a thinking block to the exact history it was produced over; a compact
rewrites that history. Accounts created on or after 2026-08-31, and later models for all
accounts, reject that shape with a prefix-mismatch 400 on the first request after a
compact. Older accounts accept it today. If a thread hits that 400, set the arm to `omit`
and rebuild the sidecar; no data is lost.
Reference: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking

## Publishing

`node scripts/assemble-npm-package.mjs --source-sha <commit>` writes `build/claude-lhc-npm`
(dist, bin, README, LICENSE, and the `lhc` core bundled under node_modules); `npm pack` it for
the tarball. `.github/workflows/publish-claude-lhc-<version>.yml` rebuilds that tarball from the
pinned commit, checks its sha256 against the reviewed hash, and publishes it (dispatch only).
