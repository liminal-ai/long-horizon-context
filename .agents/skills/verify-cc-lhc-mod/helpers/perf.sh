#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"
runs="${1:-10}"
home="$(new_home)"
session="${VERIFY_TMUX_PREFIX:-verify-cc-lhc-mod}-perf"

new_sidecar_log() {
  local before="$1" deadline=$((SECONDS + 30)) log
  while [ "$SECONDS" -lt "$deadline" ]; do
    log="$(ls "$home"/lhc/logs/sidecar-*.log 2>/dev/null | grep -vxF -f <(printf '%s\n' "$before") | head -1 || true)"
    [ -n "$log" ] && { echo "$log"; return 0; }
    sleep 0.1
  done
  return 1
}

launch() {
  local mode="$1" cmd t0 t1
  cmd="$(claude_cmd "$home" "perf" --model sonnet)"
  [ "$mode" = plain ] && cmd="${cmd/ --plugin-dir $(printf %q "$PLUGIN")/}"
  local before
  before="$(ls "$home"/lhc/logs/sidecar-*.log 2>/dev/null || true)"
  t0=$(date +%s%N)
  start_tmux "$session" "$cmd"
  accept_trust "$session" || { echo "no prompt box" >&2; exit 1; }
  t1=$(date +%s%N)
  local rss="-"
  if [ "$mode" = mod ]; then
    local log pid
    log="$(new_sidecar_log "$before")"
    wait_for 30 "bound session" "$log" >/dev/null
    pid="$(grep -ah 'listening .* pid ' "$log" | sed 's/.* pid //')"
    rss="$(ps -o rss= -p "$pid" | tr -d ' ')"
  fi
  tmux kill-session -t "=$session"
  echo "$mode $(((t1 - t0) / 1000000)) $rss"
}

launch plain >/dev/null # first launch trusts the work dir
for i in $(seq 1 "$runs"); do
  launch plain
  launch mod
done | tee "$EVIDENCE_DIR/perf-launches.txt"
median() { sort -n | awk '{a[NR]=$1} END {print (NR % 2) ? a[(NR+1)/2] : (a[NR/2] + a[NR/2+1]) / 2}'; }
plain_ms="$(awk '$1=="plain"{print $2}' "$EVIDENCE_DIR/perf-launches.txt" | median)"
mod_ms="$(awk '$1=="mod"{print $2}' "$EVIDENCE_DIR/perf-launches.txt" | median)"
rss_kb="$(awk '$1=="mod"{print $3}' "$EVIDENCE_DIR/perf-launches.txt" | sort -n | tail -1)"
echo "median launch plain ${plain_ms} ms, with mod ${mod_ms} ms, added $((${mod_ms%.*} - ${plain_ms%.*})) ms; sidecar max rss ${rss_kb} KB" |
  tee "$EVIDENCE_DIR/perf-summary.txt"
