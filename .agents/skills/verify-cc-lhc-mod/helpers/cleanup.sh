#!/usr/bin/env bash
set -u
if [ -z "${VERIFY_EVIDENCE:-}" ]; then
  echo "cleanup: set VERIFY_EVIDENCE to your run's folder; it acts only on what that run recorded" >&2
  exit 2
fi
. "$(dirname "$0")/lib.sh"
scratch="$(cd "$SCRATCH_ROOT" && pwd -P)"
if [ -f "$EVIDENCE_DIR/tmux.txt" ]; then
  while IFS= read -r session; do tmux kill-session -t "=$session" 2>/dev/null || true; done <"$EVIDENCE_DIR/tmux.txt"
  : >"$EVIDENCE_DIR/tmux.txt"
fi
removed=0
if [ -f "$EVIDENCE_DIR/homes.txt" ]; then
  while IFS= read -r home; do
    resolved="$(cd "$home" 2>/dev/null && pwd -P)" || continue
    case "$resolved" in
      "$scratch"/h-*) rm -rf -- "$resolved" && removed=$((removed + 1)) ;;
      *) echo "REFUSED to remove $home (not an h-* dir under $scratch)" >&2 ;;
    esac
  done <"$EVIDENCE_DIR/homes.txt"
  : >"$EVIDENCE_DIR/homes.txt"
fi
echo "cleanup: removed $removed home(s); evidence stays in $EVIDENCE_DIR"
