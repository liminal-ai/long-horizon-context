#!/usr/bin/env bash
set -u
. "$(dirname "$0")/lib.sh"

cleanup_tmux
REMOVED=0
if [ -f "$EVIDENCE_DIR/iso-homes.txt" ]; then
  while IFS= read -r iso; do
    [ -d "$iso" ] && remove_iso_home "$iso" && REMOVED=$((REMOVED + 1))
  done <"$EVIDENCE_DIR/iso-homes.txt"
  : >"$EVIDENCE_DIR/iso-homes.txt"
fi
echo "cleanup: removed $REMOVED isolated HOME(s)"
[ -f "$EVIDENCE_DIR/results.txt" ] \
  && echo "cleanup: evidence survives at $EVIDENCE_DIR ($(ls "$EVIDENCE_DIR" | wc -l | tr -d ' ') files; results.txt present)" \
  || echo "cleanup: evidence dir $EVIDENCE_DIR (no results.txt yet)"
echo "VERIFY-CC-LHC cleanup: PASS"
