#!/usr/bin/env bash
set -u
if [ "$#" -eq 0 ]; then
  echo "usage: cleanup.sh <scratch-dir> [<scratch-dir>...]" >&2
  exit 2
fi
TMPROOT="$(cd "${TMPDIR:-/tmp}" && pwd)"
for dir in "$@"; do
  case "$(basename "$dir")" in
    verify-claude-lhc-*) ;;
    *) echo "cleanup: REFUSED $dir (not a verify-claude-lhc-* scratch dir)" >&2; exit 1 ;;
  esac
  resolved="$(cd "$(dirname "$dir")" 2>/dev/null && pwd)/$(basename "$dir")"
  case "$resolved" in
    "$TMPROOT"/*) ;;
    *) echo "cleanup: REFUSED $dir (outside $TMPROOT)" >&2; exit 1 ;;
  esac
  rm -rf -- "$resolved"
  echo "cleanup: removed $resolved"
done
echo "cleanup: evidence untouched (VERIFY_CLAUDE_LHC_EVIDENCE / summary.json location)"
