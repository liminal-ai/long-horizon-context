# shellcheck shell=bash
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
PLUGIN="$REPO_ROOT/packages/cc-lhc-mod/dist/plugin"
MAIN_CHECKOUT="$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
# One folder per run: its tmux.txt and homes.txt are the only things cleanup.sh may kill or delete.
# Machines are shared, so an unset VERIFY_EVIDENCE gets a fresh folder, never a shared one.
if [ -z "${VERIFY_EVIDENCE:-}" ]; then
  runs="${MAIN_CHECKOUT:-$REPO_ROOT}/.pstack/runs/verify-cc-lhc-mod"
  mkdir -p "$runs"
  VERIFY_EVIDENCE="$(mktemp -d "$runs/run-$(date +%Y%m%dT%H%M%S)-XXXX")"
  echo "VERIFY_EVIDENCE=$VERIFY_EVIDENCE  # export it for the rest of this run" >&2
fi
EVIDENCE_DIR="$VERIFY_EVIDENCE"
# Short, and outside any repo: the sidecar socket path must fit in 107 bytes, and Claude loads CLAUDE.md above its cwd.
SCRATCH_ROOT="${VERIFY_SCRATCH_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/verify-cc-lhc-mod/scratch}"
mkdir -p "$EVIDENCE_DIR" "$SCRATCH_ROOT"

PARENT_SESSION_ENV=(CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_CHILD_SESSION
  CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_PID CLAUDE_AGENT_SDK_VERSION
  CLAUDE_CODE_SESSION_ATTENDED CLAUDE_EFFORT CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)

new_home() {
  local home
  home="$(mktemp -d "$SCRATCH_ROOT/h-XXXX")"
  mkdir -p "$home/work" "$home/lhc"
  echo "$home" >>"$EVIDENCE_DIR/homes.txt"
  echo "$home"
}

claude_cmd() {
  local home="$1" tag="$2"
  shift 2
  local unset="" name
  for name in "${PARENT_SESSION_ENV[@]}"; do unset+=" -u $name"; done
  printf 'cd %q && env%s DISABLE_AUTOUPDATER=1 LHC_HOME=%q %s claude --plugin-dir %q --debug-file %q' \
    "$home/work" "$unset" "$home/lhc" "${VERIFY_ENV:-}" "$PLUGIN" "$home/debug-$tag.log"
  printf ' %q' "$@"
}

wait_for() {
  local timeout="$1" pattern="$2" deadline=$((SECONDS + $1)) line
  shift 2
  while [ "$SECONDS" -lt "$deadline" ]; do
    line="$(cat "$@" 2>/dev/null | grep -aE -m1 "$pattern")" && { echo "$line"; return 0; }
    sleep 0.2
  done
  echo "TIMEOUT after ${timeout}s waiting for /$pattern/" >&2
  return 1
}

start_tmux() {
  local session="$1" cmd="$2"
  tmux new-session -d -s "$session" -x 200 -y 50 "$cmd; echo EXITED; sleep 600"
  echo "$session" >>"$EVIDENCE_DIR/tmux.txt"
}

accept_trust() {
  local session="$1" deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local pane
    pane="$(tmux capture-pane -p -t "=$session:")"
    if grep -q "Yes, I trust this folder" <<<"$pane"; then
      tmux send-keys -t "=$session:" Down Enter
      sleep 0.5
      continue
    fi
    grep -q "Enter to confirm" <<<"$pane" || ! grep -q "❯" <<<"$pane" || return 0
    sleep 0.05
  done
  return 1
}

say() {
  local session="$1" text="$2"
  tmux send-keys -t "=$session:" -l "$text"
  sleep 0.3
  tmux send-keys -t "=$session:" Enter
}
