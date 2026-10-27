#!/usr/bin/env bash
# Cleanup: remove the throwaway HOMEs and tmux sessions THIS skill's runs
# recorded. Evidence in $VERIFY_CC_LHC_EVIDENCE is never removed.
# Kills only sessions recorded by name below; never kills by pattern.
set -u
. "$(dirname "$0")/lib.sh"

cleanup_tmux
REMOVED=0
if [ -f "$EVIDENCE_DIR/iso-homes.txt" ]; then
  while IFS= read -r iso; do
    case "$iso" in
      /tmp/verify-cc-lhc-home-*|"${TMPDIR:-/tmp}"/verify-cc-lhc-home-*)
        [ -d "$iso" ] && { rm -rf "$iso"; REMOVED=$((REMOVED + 1)); } ;;
      *) echo "REFUSED to remove unrecorded-path shape: $iso" >&2 ;;
    esac
  done <"$EVIDENCE_DIR/iso-homes.txt"
  : >"$EVIDENCE_DIR/iso-homes.txt"
fi
echo "cleanup: removed $REMOVED isolated HOME(s)"
[ -f "$EVIDENCE_DIR/results.txt" ] \
  && echo "cleanup: evidence survives at $EVIDENCE_DIR ($(ls "$EVIDENCE_DIR" | wc -l | tr -d ' ') files; results.txt present)" \
  || echo "cleanup: evidence dir $EVIDENCE_DIR (no results.txt yet)"
echo "VERIFY-CC-LHC cleanup: PASS"
