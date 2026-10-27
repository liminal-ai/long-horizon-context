#!/usr/bin/env bash
# Seeded drive: wrapper help/version surface in an isolated tmux PTY.
# User-only check: only the terminal and cc-lhc's own --lhc-help text.
# Outcome check: exit codes + help naming panel commands and env knobs.
set -u
. "$(dirname "$0")/lib.sh"
make_isolation

LOG="$EVIDENCE_DIR/help.log"
RC="$(run_in_tmux help "$LOG" \
  "HOME='$ISO_HOME' CC_LHC_HOME='$ISO_HOME/.cc-lhc' CLAUDE_CONFIG_DIR='$ISO_HOME/.claude' node '$CC_LHC_BIN_JS' --lhc-help; echo ---; HOME='$ISO_HOME' CC_LHC_HOME='$ISO_HOME/.cc-lhc' node '$CC_LHC_BIN_JS' --lhc-version; HOME='$ISO_HOME' CC_LHC_HOME='$ISO_HOME/.cc-lhc' node '$CC_LHC_BIN_JS' --lhc-bogus-flag; echo BOGUS_RC=\$?")" || RC=124

[ "$RC" = "0" ] && pass "tmux drive completed" || fail "tmux drive rc=$RC"
grep -q "Smart Compact is always active" "$LOG" && pass "help states Smart Compact policy" || fail "help missing Smart Compact line"
grep -q "/smart-compact" "$LOG" && pass "help names /smart-compact panel command" || fail "help missing panel commands"
grep -q "CC_LHC_HOME" "$LOG" && pass "help names CC_LHC_HOME isolation knob" || fail "help missing env section"
grep -q '^cc-lhc ' "$LOG" && pass "--lhc-version printed version line" || fail "--lhc-version line missing"
grep -q "BOGUS_RC=2" "$LOG" && pass "unknown --lhc-* flag exits 2" || fail "unknown --lhc-* flag did not exit 2 (see help.log)"

finish help
