#!/usr/bin/env bash
set -u
. "$(dirname "$0")/lib.sh"
make_isolation

LOG="$EVIDENCE_DIR/help.log"
ENV="$(iso_cmd_env)"
RC="$(run_in_tmux help "$LOG" \
  "$ENV node '$CC_LHC_BIN_JS' --lhc-help; echo ---; $ENV node '$CC_LHC_BIN_JS' --lhc-version; $ENV node '$CC_LHC_BIN_JS' --lhc-bogus-flag; echo BOGUS_RC=\$?")" || RC=124

[ "$RC" = "0" ] && pass "tmux drive completed" || fail "tmux drive rc=$RC"
grep -q "Smart Compact is always active" "$LOG" && pass "help states Smart Compact policy" || fail "help missing Smart Compact line"
grep -q "at the 700k trigger" "$LOG" && grep -q "toward a 120k target" "$LOG" && pass "help states the built-in 700k trigger and 120k target" || fail "help missing built-in 700k/120k bounds"
grep -q "/smart-compact" "$LOG" && pass "help names /smart-compact panel command" || fail "help missing panel commands"
grep -q "CC_LHC_HOME" "$LOG" && pass "help names CC_LHC_HOME isolation knob" || fail "help missing env section"
grep -q '^cc-lhc ' "$LOG" && pass "--lhc-version printed version line" || fail "--lhc-version line missing"
grep -q "BOGUS_RC=2" "$LOG" && pass "unknown --lhc-* flag exits 2" || fail "unknown --lhc-* flag did not exit 2 (see help.log)"

finish help
