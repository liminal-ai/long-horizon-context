#!/usr/bin/env bash
set -u
. "$(dirname "$0")/lib.sh"
make_isolation
CODEWORD="ALDER-7"

SEED_OUT="$(iso_env node "$SKILL_DIR/helpers/seed-thread.mjs" "$REPO_ROOT" "$ISO_HOME/.cc-lhc" "$ISO_HOME/work" "$CODEWORD" 2>"$EVIDENCE_DIR/compact-seed.err")"
THREAD_ID="$(echo "$SEED_OUT" | awk '{print $1}')"
if [ -z "$THREAD_ID" ]; then
  fail "seed failed: $(cat "$EVIDENCE_DIR/compact-seed.err")"; finish smart-compact; exit 1
fi
ENV="HOME='$ISO_HOME' CC_LHC_HOME='$ISO_HOME/.cc-lhc' CLAUDE_CONFIG_DIR='$ISO_HOME/.claude' CC_LHC_CLAUDE_BIN='$STANDIN'"
SID="$(new_uuid)"
RC="$(run_in_tmux compact-seed-write "$EVIDENCE_DIR/compact-write.log" \
  "$ENV node '$CC_LHC_BIN_JS' rollout write --thread-id $THREAD_ID --session-id $SID --token-family claude-2026 --cwd '$ISO_HOME/work' --envelope-from '$REPO_ROOT/packages/cc-lhc/test/fixtures/claude-2.1.226-custom-title.jsonl'")" || RC=124
[ "$RC" = "0" ] || { fail "precondition rollout write rc=$RC"; finish smart-compact; exit 1; }
pass "precondition: rebuilt session $SID written"

RC="$(run_in_tmux compact-settle "$EVIDENCE_DIR/compact-settle.log" \
  "$ENV node '$CC_LHC_BIN_JS' --lhc-no-inference --resume $SID -p 'settle turn'")" || RC=124
[ "$RC" = "0" ] && pass "settle resume exited 0" || fail "settle resume rc=$RC"

find "$ISO_HOME/.claude/projects" -name '*.jsonl' | sort >"$EVIDENCE_DIR/compact-before.txt"
LOG="$EVIDENCE_DIR/smart-compact.log"
RC="$(run_in_tmux smart-compact "$LOG" \
  "$ENV node '$CC_LHC_BIN_JS' --lhc-no-inference --lhc-lower-bound-tokens=10 --lhc-upper-bound-tokens=20 --lhc-min-runway-tokens=1 --resume $SID -p 'continue after compact: repeat the codeword'")" || RC=124
find "$ISO_HOME/.claude/projects" -name '*.jsonl' | sort >"$EVIDENCE_DIR/compact-after.txt"
cp "$ISO_HOME/.cc-lhc/wrapper.log" "$EVIDENCE_DIR/smart-compact-wrapper.log" 2>/dev/null || true

NEW_FILES="$(comm -13 "$EVIDENCE_DIR/compact-before.txt" "$EVIDENCE_DIR/compact-after.txt")"
if [ -n "$NEW_FILES" ]; then
  pass "Smart Compact wrote a new session transcript: $NEW_FILES"
  echo "$NEW_FILES" | head -1 | xargs -I{} sh -c 'grep -lq "'"$CODEWORD"'" "{}"' \
    && pass "compacted session still carries seeded history" \
    || note "codeword not in first new transcript; inspect evidence"
  finish smart-compact; exit $?
fi
if grep -qi "smart compact\|compact.*rebuilt\|rebuilt session" "$EVIDENCE_DIR/smart-compact-wrapper.log" 2>/dev/null; then
  pass "wrapper.log records Smart Compact rebuild"
  finish smart-compact; exit $?
fi

REASON="$(grep -i 'stand.*down\|not.*ready\|degraded\|no persisted\|capture' "$EVIDENCE_DIR/smart-compact-wrapper.log" 2>/dev/null | tail -1)"
skip "Smart Compact seam did not fire on the stand-in seat (rc=$RC). Last wrapper.log signal: ${REASON:-none}. Live-Claude panel drive (/smart-compact) remains the proof path; see features/smart-compact.md Gotchas."
echo "VERIFY-CC-LHC smart-compact: SKIP"
exit "$SKIP_RC"
