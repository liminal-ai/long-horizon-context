# shellcheck shell=bash

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
CC_LHC_BIN_JS="$REPO_ROOT/packages/cc-lhc/dist/bin.js"
STANDIN="$REPO_ROOT/packages/cc-lhc/test/fixtures/oneshot-claude.mjs"

EVIDENCE_DIR="${VERIFY_CC_LHC_EVIDENCE:-/tmp/verify-cc-lhc-evidence}"
mkdir -p "$EVIDENCE_DIR"

SKIP_RC=3
FAILURES=0
pass() { echo "PASS: $*"; echo "PASS: $*" >>"$EVIDENCE_DIR/results.txt"; }
fail() { echo "FAIL: $*"; echo "FAIL: $*" >>"$EVIDENCE_DIR/results.txt"; FAILURES=$((FAILURES + 1)); }
skip() { echo "SKIP: $*"; echo "SKIP: $*" >>"$EVIDENCE_DIR/results.txt"; }
note() { echo "NOTE: $*"; }

make_isolation() {
  ISO_HOME="$(mktemp -d "${TMPDIR:-/tmp}/verify-cc-lhc-home-XXXXXX")"
  mkdir -p "$ISO_HOME/work" "$ISO_HOME/.claude"
  export VERIFY_CC_LHC_ISOLATED=1
  export ISO_HOME
  echo "$ISO_HOME" >>"$EVIDENCE_DIR/iso-homes.txt"
}

require_isolation() {
  if [ "${VERIFY_CC_LHC_ISOLATED:-}" != "1" ] || [ -z "${ISO_HOME:-}" ]; then
    echo "REFUSED: no isolated HOME (call make_isolation first)" >&2
    exit 2
  fi
  case "$ISO_HOME" in
    "$HOME"|"$HOME"/*)
      if [ "$ISO_HOME" = "$HOME" ]; then
        echo "REFUSED: ISO_HOME is the operator HOME" >&2; exit 2
      fi ;;
  esac
}

iso_env() {
  require_isolation
  env -u CC_LHC_RUNTIME_DESCRIPTOR \
    HOME="$ISO_HOME" \
    CC_LHC_HOME="$ISO_HOME/.cc-lhc" \
    CLAUDE_CONFIG_DIR="$ISO_HOME/.claude" \
    XDG_CONFIG_HOME="$ISO_HOME/.config" \
    "$@"
}

iso_cmd_env() {
  require_isolation
  printf "env -u CC_LHC_RUNTIME_DESCRIPTOR HOME='%s' CC_LHC_HOME='%s/.cc-lhc' CLAUDE_CONFIG_DIR='%s/.claude' XDG_CONFIG_HOME='%s/.config'" \
    "$ISO_HOME" "$ISO_HOME" "$ISO_HOME" "$ISO_HOME"
}

new_uuid() { node -e 'console.log(crypto.randomUUID())'; }

TMUX_SESSION=""
run_in_tmux() {
  local name="$1" log="$2" cmd="$3"
  require_isolation
  TMUX_SESSION="cc-lhc-verify-${name}-$$"
  local exit_file="$ISO_HOME/${name}.exit"
  rm -f "$exit_file"
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$TMUX_SESSION" -x 200 -y 50 -c "$ISO_HOME/work"
  tmux send-keys -t "$TMUX_SESSION" \
    "{ $cmd ; } >'$log' 2>&1 </dev/null; echo \$? >'$exit_file'" Enter
  local deadline=$((SECONDS + ${VERIFY_CC_LHC_TIMEOUT:-240}))
  while [ ! -f "$exit_file" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      tmux capture-pane -p -t "$TMUX_SESSION" >"$EVIDENCE_DIR/${name}-pane.txt" 2>/dev/null || true
      tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
      fail "$name timed out after ${VERIFY_CC_LHC_TIMEOUT:-240}s (pane: ${name}-pane.txt)"
      return 124
    fi
    sleep 1
  done
  tmux capture-pane -p -t "$TMUX_SESSION" >"$EVIDENCE_DIR/${name}-pane.txt" 2>/dev/null || true
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  TMUX_SESSION=""
  cat "$exit_file"
}

cleanup_tmux() {
  if [ -n "${TMUX_SESSION:-}" ]; then
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    TMUX_SESSION=""
  fi
}
trap cleanup_tmux EXIT

finish() {
  local name="$1"
  if [ "$FAILURES" -eq 0 ]; then
    echo "VERIFY-CC-LHC $name: PASS"
    return 0
  fi
  echo "VERIFY-CC-LHC $name: FAIL ($FAILURES failures)"
  return 1
}
