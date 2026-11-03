#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"
session="$1"
[ -n "${2:-}" ] && tmux capture-pane -p -t "=$session:" >"$2"
say "$session" "/exit"
for _ in $(seq 1 50); do tmux capture-pane -p -t "=$session:" | grep -q EXITED && break; sleep 0.2; done
tmux kill-session -t "=$session"
