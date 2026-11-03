#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"
runs="${1:-2}"
calls="${CAPTURE_PERF_CALLS:-40}"
prompt="Use the Bash tool $calls times, one call per message, running echo 1, then echo 2, and so on up to echo $calls. Then reply DONE."

p95() { sort -n | awk '{ v[NR] = $1 } END { if (NR == 0) { print "-"; exit } i = int(NR * 0.95); if (i < 1) i = 1; print v[i] }'; }

run() {
  local n="$1" mode="$2" home cmd t0 t1 transcript rows extra=""
  home="$(new_home)"
  cmd="$(claude_cmd "$home" "perf-$n-$mode" --model haiku --allowedTools Bash -p "$prompt")"
  [ "$mode" = plain ] && cmd="${cmd/ --plugin-dir $(printf %q "$PLUGIN")/}"
  t0=$(date +%s%N)
  bash -c "$cmd" >"$home/out.txt" 2>&1
  t1=$(date +%s%N)
  transcript="$(ls -t "$HOME"/.claude/projects/*"$(basename "$home")"-work/*.jsonl 2>/dev/null | head -1)"
  rows="$(grep -c '"uuid"' "$transcript" 2>/dev/null || echo 0)"
  if [ "$mode" = mod ]; then
    local hook lag
    hook="$(grep -ah 'capture hook rows' "$home"/lhc/logs/mod-*.log | sed 's/.* p95 \([0-9.]*\)ms.*/\1/' | p95)"
    lag="$(grep -ah 'captured .* lag ' "$home"/lhc/logs/sidecar-*.log | sed 's/.* lag \([0-9]*\)ms/\1/' | p95)"
    extra=" hook_p95 $hook lag_p95 $lag"
  fi
  echo "run $n $mode wall $(((t1 - t0) / 1000000)) rows $rows$extra session $(basename "$transcript" .jsonl)"
}

for n in $(seq 1 "$runs"); do
  run "$n" plain
  run "$n" mod
done
