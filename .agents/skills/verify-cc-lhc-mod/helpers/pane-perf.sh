#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"
session="$1"
runs="${2:-10}"
target="=$session:"
if [ "${VERIFY_ISOLATED_CONFIG:-}" != "1" ]; then
  echo "pane-perf.sh types /lhc bounds, which writes the plugin's settings: launch the session with VERIFY_ISOLATED_CONFIG=1 and set it here too." >&2
  exit 2
fi
if [ "$(tmux display -p -t "$target" '#{alternate_on}')" = "1" ]; then
  echo "pane-perf.sh needs the default renderer: /context's output scrolls into history only there. Run /tui default first." >&2
  exit 2
fi
ms() { echo $(($(date +%s%N) / 1000000)); }
screen() { tmux capture-pane -p -t "$target" -S -3000; }
count() { screen | grep -c "$1" || true; }
until_count() {
  local pattern="$1" above="$2" deadline=$(($(ms) + 10000))
  while [ "$(count "$pattern")" -le "$above" ]; do
    [ "$(ms)" -lt "$deadline" ] || { echo "TIMEOUT waiting for $pattern" >&2; exit 1; }
    sleep 0.01
  done
}
type_line() { tmux send-keys -t "$target" -l "$1"; sleep 0.2; }
median() { sort -n | awk '{a[NR]=$1} END {print (NR % 2 ? a[(NR+1)/2] : int((a[NR/2]+a[NR/2+1])/2))}'; }
close_pane() {
  local tries
  for tries in 1 2 3 4 5; do
    [ "$(tmux capture-pane -p -t "$target" | grep -c 'Long Horizon Context' || true)" -eq 0 ] && return 0
    tmux send-keys -t "$target" C-x; sleep 0.2; tmux send-keys -t "$target" Tab; sleep 0.3   # ctrl+x x closes only a focused pane
    tmux send-keys -t "$target" C-x; sleep 0.2; tmux send-keys -t "$target" x; sleep 0.5
  done
  echo "could not close the pane" >&2; exit 1
}
context=() open=() redraw=()
for i in $(seq "$runs"); do
  close_pane
  before="$(count 'Context Usage')"
  type_line "/context"; start="$(ms)"; tmux send-keys -t "$target" Enter
  until_count 'Context Usage' "$before"; context+=($(($(ms) - start)))
  sleep 0.3
  before="$(count 'Long Horizon Context')"
  type_line "/lhc"; start="$(ms)"; tmux send-keys -t "$target" Enter
  until_count 'Long Horizon Context' "$before"; open+=($(($(ms) - start)))
  sleep 0.3
  bound=$((600 + 10 * i + RANDOM % 9))
  before="$(count "Upper bound: ${bound}k")"
  tmux send-keys -t "$target" Escape; sleep 0.2
  type_line "/lhc bounds 140k ${bound}k 90"; start="$(ms)"; tmux send-keys -t "$target" Enter
  until_count "Upper bound: ${bound}k" "$before"; redraw+=($(($(ms) - start)))
  sleep 1.5
done
close_pane
echo "context_ms ${context[*]} median $(printf '%s\n' "${context[@]}" | median)"
echo "open_ms ${open[*]} median $(printf '%s\n' "${open[@]}" | median)"
echo "redraw_ms ${redraw[*]} median $(printf '%s\n' "${redraw[@]}" | median) max $(printf '%s\n' "${redraw[@]}" | sort -n | tail -1)"
