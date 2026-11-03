#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"
session="$1"
shift
home=""
if [ $# -gt 0 ] && [ "$1" != "--" ]; then home="$1"; shift; fi
[ "${1:-}" = "--" ] && shift
[ -n "$home" ] || home="$(new_home)"
[ -f "$PLUGIN/hooks/register.js" ] || { echo "no built plugin at $PLUGIN; run pnpm --filter lhc build && pnpm --filter claude-adapter build && pnpm --filter cc-lhc-mod build" >&2; exit 2; }
binds_before="$(cat "$home"/lhc/logs/sidecar-*.log 2>/dev/null | grep -c 'bound session' || true)"
start_tmux "$session" "$(claude_cmd "$home" "$session" "$@")"
accept_trust "$session" || { echo "no prompt box in $session" >&2; tmux capture-pane -p -t "=$session:" >&2; exit 1; }
deadline=$((SECONDS + 30))
while [ "$(cat "$home"/lhc/logs/sidecar-*.log 2>/dev/null | grep -c 'bound session' || true)" -le "$binds_before" ]; do
  [ "$SECONDS" -lt "$deadline" ] || { echo "no bind within 30s" >&2; exit 1; }
  sleep 0.2
done
echo "HOME=$home"
grep -ah 'bound session' "$home"/lhc/logs/sidecar-*.log | tail -1
