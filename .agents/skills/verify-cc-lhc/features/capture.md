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
  (live drives only; needs throwaway-HOME Claude login).

## Driving it with verify-cc-lhc helpers

Preconditions:

- Baseline preconditions in [README.md](./README.md) hold.
- `helpers/doctor.sh` passes.

- **Seeded one-shot (user-only + outcome).** Run
  `helpers/drive-capture.sh`. It launches the wrapper in tmux with the
  stand-in Claude, prompt `seed prompt: the codeword is ALDER-7`, and a
  fresh session id. User-only: stdout shows `ok`, exit 0. Outcome:
  `<ISO>/.claude/projects/*/<sid>.jsonl` contains `ALDER-7`,
  `.cc-lhc/cc-lhc.sqlite`, `registry.sqlite`, and a thread sqlite exist,
  and `wrapper.log` records `cc-lhc owns thread …`. Pass line:
  `VERIFY-CC-LHC capture: PASS`.
- **Isolation outcome.** The same drive asserts no `<sid>.jsonl` exists
  under the operator's real `~/.claude/projects`.
- **Interactive entry (live only).** In an isolated tmux session with a
  throwaway-HOME Claude login, run the built wrapper with no `-p`, send
  one prompt, wait for the reply in the pane (`tmux capture-pane -p`),
  exit Claude, then grade the same outcome files. Without throwaway
  login, report `SKIP: no throwaway-HOME Claude credentials`.

## Gotchas

- `CLAUDE_CONFIG_DIR` does not isolate cc-lhc: transcripts resolve from
  `homedir()/.claude/projects`. Always throwaway `HOME`.
- The first one-shot for a brand-new session launches directly (log:
  `has no persisted transcript yet`); its exit summary can read
  `lines=0 … thread=none` while the thread lease and transcript are
  still the outcome proof. Do not assert non-zero capture lines there.
- Resuming a stand-in-written transcript whose prefix the wrapper never
  observed degrades capture (`prefix_boundary:unknown_provenance` in
  `wrapper.log`). Rebuild first (see [rebuild.md](./rebuild.md)); never
  weaken the drive to ignore a degraded-capture line.
- Without the native addon every launch exits 2
  (`addon_unavailable`). That is a Launch problem, not a capture result.
- The stand-in proves wrapper behavior at the `CC_LHC_CLAUDE_BIN`
  boundary only. It never proves a real Claude launch or auth path.
