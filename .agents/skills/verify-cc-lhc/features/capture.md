# Scripted session capture

Capture records a Claude session's conversation into an append-only LHC
thread as it runs, so the thread survives session rebuilds and past turns
stay retrievable. The user sees an ordinary Claude session; the proof is
that the thread, transcript, and capture summary exist afterward.

## Sub-features

- `capture-oneshot` — a `-p` one-shot creates a thread and transcript.
- `capture-resume` — a resumed session keeps appending to the same thread.
- `capture-summary` — exit prints the `cc-lhc-capture lines=…` summary.
- `capture-isolation` — nothing lands in the operator's real `~/.claude`.

## How to get to it (user POV)

- Run `cc-lhc -p "<prompt>" --session-id <uuid>` for a one-shot.
- Run `cc-lhc --resume <uuid> -p "<prompt>"` to continue it.
- Run `cc-lhc` interactively and hold a normal Claude conversation
  (live drives only; needs throwaway-HOME Claude auth).

## Driving it with verify-cc-lhc helpers

Preconditions:

- Baseline preconditions in [README.md](./README.md) hold.
- `helpers/doctor.sh` passes.

- **Seeded one-shot (user-only + outcome).** Run
  `helpers/drive-capture.sh`. It launches the wrapper in tmux with
  `helpers/capture-bound-claude.mjs` as Claude, prompt `seed prompt: the
  codeword is ALDER-7`, and a fresh session id. That child runs the repo
  stand-in, then stays up until `wrapper.log` shows `cc-lhc capture
  ready` (or `capture degraded`), the way a real Claude outlives the
  bind. User-only: stdout shows `ok`, exit 0. Outcome: the
  `cc-lhc-capture` summary has `lines=` and `events=` above 0 and
  `thread=` equal to the thread `wrapper.log` says it owns, the thread
  sqlite holds `ALDER-7`, `<ISO>/.claude/projects/*/<sid>.jsonl`
  contains `ALDER-7`, and `.cc-lhc/cc-lhc.sqlite` and `registry.sqlite`
  exist. Pass line: `VERIFY-CC-LHC capture: PASS`.
- **Broken-case probe.** `helpers/probe-checks.sh` reruns the drive with
  `VERIFY_CC_LHC_CAPTURE_BIN` set to the bare repo stand-in, which exits
  before the bind. The drive must fail with `capture ingested nothing`
  (summary `lines=0 … thread=none`), and pass again with the default
  child. It also feeds `capture_ingested` (in `lib.sh`, which reads the
  summary's `key=value` tokens in any order) a reordered summary that
  must pass, and a zero-count and a wrong-thread summary that must fail.
- **Isolation outcome.** The same drive asserts no `<sid>.jsonl` exists
  under the operator's real `~/.claude/projects`.
- **Interactive entry (live only).** In an isolated tmux session with a
  throwaway-HOME Claude auth, run the built wrapper with no `-p`, get
  past the welcome panel and Claude's first-run prompts (see
  [control-panel.md](./control-panel.md)), send one prompt, wait for the
  reply in the pane (`tmux capture-pane -p`), exit Claude with `/exit`,
  then grade the same outcome files plus an exit summary with `events=`
  above 0 and a `thread=th_…`. Without throwaway auth, report
  `SKIP: no throwaway-HOME Claude credentials`.

## Gotchas

- `CLAUDE_CONFIG_DIR` does not isolate cc-lhc: transcripts resolve from
  `homedir()/.claude/projects`. Always throwaway `HOME`.
- The first one-shot for a brand-new session launches directly (log:
  `has no persisted transcript yet`), and capture binds by polling for
  the transcript (`discoverExpectedSessionFile`). A child that writes its
  transcript and exits in milliseconds, like the bare repo stand-in, is
  stopped before the bind, so the summary reads `lines=0 … thread=none`.
  That is why the drive uses `capture-bound-claude.mjs`. Never weaken the
  ingestion assertion to pass a child that exits early.
- Resuming a stand-in-written transcript whose prefix the wrapper never
  observed degrades capture (`prefix_boundary:unknown_provenance` in
  `wrapper.log`). Rebuild first (see [rebuild.md](./rebuild.md)); never
  weaken the drive to ignore a degraded-capture line.
- Without the native addon every launch exits 2
  (`addon_unavailable`). That is a Launch problem, not a capture result.
- The stand-in proves wrapper behavior at the `CC_LHC_CLAUDE_BIN`
  boundary only. It never proves a real Claude launch or auth path.
