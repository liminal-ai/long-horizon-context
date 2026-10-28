#!/usr/bin/env bash
set -u
if [ "$#" -eq 0 ]; then
  echo "usage: cleanup.sh <scratch-dir> [<scratch-dir>...]" >&2
  exit 2
fi
SCRATCH_ROOT="${VERIFY_SCRATCH_ROOT:-${XDG_STATE_HOME:-$HOME/.local/state}/verify-claude-lhc/scratch}"
if [ ! -d "$SCRATCH_ROOT" ]; then
  echo "cleanup: no scratch root at $SCRATCH_ROOT; nothing to remove"
  exit 0
fi
SCRATCH_ROOT="$(cd "$SCRATCH_ROOT" && pwd -P)"
for dir in "$@"; do
  case "$(basename "$dir")" in
    verify-claude-lhc-*) ;;
    *) echo "cleanup: REFUSED $dir (not a verify-claude-lhc-* scratch dir)" >&2; exit 1 ;;
  esac
  resolved="$(cd "$(dirname "$dir")" 2>/dev/null && pwd -P)/$(basename "$dir")"
  case "$resolved" in
    "$SCRATCH_ROOT"/*) ;;
    *) echo "cleanup: REFUSED $dir (outside $SCRATCH_ROOT)" >&2; exit 1 ;;
  esac
  if [ ! -e "$resolved" ]; then
    echo "cleanup: $resolved already gone"
    continue
  fi
  rm -rf -- "$resolved"
  echo "cleanup: removed $resolved"
done
echo "cleanup: evidence untouched (VERIFY_CLAUDE_LHC_EVIDENCE / summary.json location)"
