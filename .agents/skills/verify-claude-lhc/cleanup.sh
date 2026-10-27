#!/usr/bin/env bash
# Cleanup: remove scratch homes a drive kept (VERIFY_KEEP_SCRATCH=1), never evidence.
# Usage: cleanup.sh <scratch-dir> [<scratch-dir>...]
# Refuses anything that is not a verify-claude-lhc-* dir under the system tmp dir.
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
  # Never kill by process name: drives own their sidecars and close stdin to stop them.
  # Here we only remove files the drive created.
  rm -rf -- "$resolved"
  echo "cleanup: removed $resolved"
done
echo "cleanup: evidence untouched (VERIFY_CLAUDE_LHC_EVIDENCE / summary.json location)"
