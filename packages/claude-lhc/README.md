# claude-lhc

Claude Code sidecar for t3code's LHC provider instance. Runs the Claude Agent SDK (pinned 0.3.170,
the version t3code installs) against the Claude Code binary t3code points it at, records every
native message into an LHC thread as the primary record, and forwards the raw SDK stream to the
driver unchanged over JSONL stdio. The native session is a projection of the LHC served view: every
restart and every compact mints a fresh native session id from that view.

- `src/protocol.ts` — the wire: `start`, `user`, `req`/`res`, `abort`, `msg`, `error`.
- `src/session.ts` — generations, capture-before-forward, manual/auto compact, projection swap.
- `src/capture/mapper.ts` — SDK messages → LHC intake events (cc-lhc's rules on the wire shapes).
- `src/projection/project.ts` — LHC served view → native transcript lines (`sessionStore.load`).
- `src/lhcHome.ts` — host `t3code-lhc`: `~/.t3code-lhc` (`T3CODE_LHC_HOME`), aliases `t3code-lhc:<session id>`.
- `src/inference/claudeCli.ts` — derivations through `claude -p --no-session-persistence`.
- `bin/claude-lhc` — launcher (bun). `scripts/standalone.ts` — end-to-end proof without t3code.
