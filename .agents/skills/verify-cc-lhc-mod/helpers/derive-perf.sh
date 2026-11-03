#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"
runs="${1:-3}"
lanes="${DERIVE_LANES:-sdk bridge}"
turns=10

prompt_for() {
  if [ "$1" -le 6 ]; then
    echo "Read f$1.txt with the Read tool and reply with only its last word."
  else
    echo "Run seq 1 $(($1 * 50)) with the Bash tool and reply with only the last number it printed."
  fi
}

now_ms() { date +%s%3N; }
turns_done() { cat "$1"/lhc/logs/mod-*.log 2>/dev/null | grep -ac 'capture hook rows' || true; }
health() { node "$REPO_ROOT/packages/lhc/dist/cli.js" thread health --home "$1/lhc" --thread-id "$2"; }

run() {
  local n="$1" lane="$2" home session settings socket pid thread t0 t1 t2 before i line
  home="$(new_home)"
  "$SKILL_DIR/helpers/fixtures.sh" "$home" >/dev/null
  session="${VERIFY_TMUX_PREFIX:-ccv2-derive}-$n-$lane"
  settings="{\"pluginConfigs\":{\"lhc@inline\":{\"options\":{\"inferenceWorker\":\"$lane\"}}}}"
  "$SKILL_DIR/helpers/launch.sh" "$session" "$home" -- --model sonnet --settings "$settings" >/dev/null
  socket="$(ls "$home"/lhc/run/*.sock | head -1)"
  pid="$(curl -s --unix-socket "$socket" http://x/health | node -pe 'JSON.parse(require("fs").readFileSync(0)).pid')"
  thread="$(grep -aho 'thread th_[0-9a-f]*' "$home"/lhc/logs/sidecar-*.log | head -1 | cut -d' ' -f2)"
  grep -aq "model lane $lane" "$home"/lhc/logs/sidecar-*.log || { echo "run $n: the sidecar did not start lane $lane" >&2; return 1; }
  t0="$(now_ms)"
  for i in $(seq 1 "$turns"); do
    before="$(turns_done "$home")"
    say "$session" "$(prompt_for "$i")"
    local deadline=$((SECONDS + 240))
    while [ "$(turns_done "$home")" -le "$before" ]; do
      [ "$SECONDS" -lt "$deadline" ] || { echo "run $n: turn $i did not end" >&2; return 1; }
      sleep 0.5
    done
  done
  t1="$(now_ms)"
  local deadline=$((SECONDS + 900)) settled=0
  while [ "$settled" -lt 2 ]; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "run $n: derivations did not drain" >&2; break; }
    line="$(health "$home" "$thread")"
    if grep -q ' pending=0 ' <<<"$line"; then settled=$((settled + 1)); else settled=0; fi
    sleep 1
  done
  t2="$(now_ms)"
  local rss peak
  rss="$(awk '/VmRSS/ { printf "%d", $2 / 1024 }' "/proc/$pid/status")"
  peak="$(awk '/VmHWM/ { printf "%d", $2 / 1024 }' "/proc/$pid/status")"
  line="$(health "$home" "$thread")"
  local calls p50
  calls="$(cat "$home"/lhc/logs/sidecar-*.log | grep -ac 'model call .* took ' || true)"
  p50="$(cat "$home"/lhc/logs/sidecar-*.log | grep -a 'model call .* took ' | sed 's/.* took \([0-9]*\)ms/\1/' | sort -n | awk '{ v[NR] = $1 } END { print NR ? v[int((NR + 1) / 2)] : "-" }')"
  "$SKILL_DIR/helpers/stop.sh" "$session" "$home/pane.txt" >/dev/null
  echo "run $n lane $lane turns_ms $((t1 - t0)) drain_ms $((t2 - t1)) calls $calls call_p50_ms $p50 total_ms $((t2 - t0)) rss_mib $rss peak_mib $peak $line home $home session $(grep -aho 'bound session [0-9a-f-]*' "$home"/lhc/logs/sidecar-*.log | head -1 | cut -d' ' -f3)"
}

for n in $(seq 1 "$runs"); do
  for lane in $lanes; do run "$n" "$lane"; done
done
