#!/usr/bin/env bash
# Run every seeded drive once, timed. Perf rule: all drives together
# finish inside 10 minutes warm. smart-compact exit 3 (SKIP) is reported,
# not counted as failure; every other non-zero fails the run.
set -u
. "$(dirname "$0")/lib.sh"

START=$SECONDS
FAILED=0
for drive in doctor drive-help drive-capture drive-rebuild drive-smart-compact; do
  T0=$SECONDS
  echo "=== $drive ==="
  "$SKILL_DIR/helpers/$drive.sh"; RC=$?
  ELAPSED=$((SECONDS - T0))
  echo "$drive rc=$RC elapsed=${ELAPSED}s" | tee -a "$EVIDENCE_DIR/timings.txt"
  if [ "$drive" = "drive-smart-compact" ] && [ "$RC" -eq 3 ]; then
    echo "NOTE: smart-compact SKIP (see results.txt reason)"
  elif [ "$RC" -ne 0 ]; then
    FAILED=1
  fi
done
TOTAL=$((SECONDS - START))
echo "total=${TOTAL}s budget=600s" | tee -a "$EVIDENCE_DIR/timings.txt"
[ "$TOTAL" -le 600 ] || { echo "FAIL: seeded drives exceeded 10-minute budget"; FAILED=1; }
"$SKILL_DIR/helpers/cleanup.sh"
if [ "$FAILED" -eq 0 ]; then echo "VERIFY-CC-LHC seeded-drives: PASS"; else echo "VERIFY-CC-LHC seeded-drives: FAIL"; exit 1; fi
