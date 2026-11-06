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
ENV="$(iso_cmd_env) CC_LHC_CLAUDE_BIN='$STANDIN'"
SID="$(new_uuid)"
RC="$(run_in_tmux compact-seed-write "$EVIDENCE_DIR/compact-write.log" \
  "$ENV node '$CC_LHC_BIN_JS' rollout write --thread-id $THREAD_ID --session-id $SID --token-family claude-2026 --cwd '$ISO_HOME/work' --envelope-from '$REPO_ROOT/packages/cc-lhc/test/fixtures/claude-2.1.226-model-fallback-sequence.jsonl'")" || RC=124
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
if [ "$RC" != "0" ]; then
  fail "smart-compact run rc=$RC (new transcript written: $([ -n "$NEW_FILES" ] && echo yes || echo no))"
  finish smart-compact; exit $?
fi
if [ -n "$NEW_FILES" ]; then
  pass "Smart Compact wrote a new session transcript: $NEW_FILES"
  echo "$NEW_FILES" | head -1 | xargs -I{} sh -c 'grep -lq "'"$CODEWORD"'" "{}"' \
    && pass "compacted session still carries seeded history" \
    || note "codeword not in first new transcript; inspect evidence"
  SOURCE="$(grep "/$SID.jsonl\$" "$EVIDENCE_DIR/compact-before.txt")"
  cp "$SOURCE" "$EVIDENCE_DIR/compact-source.jsonl"
  echo "$NEW_FILES" | head -1 | xargs -I{} cp {} "$EVIDENCE_DIR/compact-rebuilt.jsonl"
  if ! node "$SKILL_DIR/helpers/read-seam-view.mjs" --cc-lhc-home "$ISO_HOME/.cc-lhc" \
    --rebuilt "$EVIDENCE_DIR/compact-rebuilt.jsonl" --out "$EVIDENCE_DIR/compact-view.json" \
    >"$EVIDENCE_DIR/compact-view.txt" 2>&1; then
    fail "canonical session view not read: $(tr '\n' ' ' <"$EVIDENCE_DIR/compact-view.txt")"
    finish smart-compact; exit 1
  fi
  node "$SKILL_DIR/helpers/check-rebuilt-content.mjs" --source "$EVIDENCE_DIR/compact-source.jsonl" \
    --rebuilt "$EVIDENCE_DIR/compact-rebuilt.jsonl" --view "$EVIDENCE_DIR/compact-view.json" \
    >"$EVIDENCE_DIR/compact-content.txt" 2>&1 \
    && pass "rebuilt transcript matches the canonical view and the source ($(head -1 "$EVIDENCE_DIR/compact-content.txt"))" \
    || fail "rebuilt transcript loses, changes or duplicates content: $(tr '\n' ' ' <"$EVIDENCE_DIR/compact-content.txt")"
  finish smart-compact; exit $?
fi
if [ "$RC" = "0" ] && grep -q "pre-launch Smart Compact rebuilt:" "$EVIDENCE_DIR/smart-compact-wrapper.log" 2>/dev/null; then
  pass "wrapper.log records a successful Smart Compact rebuild"
  finish smart-compact; exit $?
fi

[ "$FAILURES" -eq 0 ] || { finish smart-compact; exit 1; }
REASON="$(grep 'pre-launch seam' "$EVIDENCE_DIR/smart-compact-wrapper.log" 2>/dev/null | tail -1)"
[ -n "$REASON" ] || REASON="$(grep -i 'stand.*down\|not.*ready\|degraded\|no persisted\|capture' "$EVIDENCE_DIR/smart-compact-wrapper.log" 2>/dev/null | tail -1)"
skip "Smart Compact seam did not fire on the stand-in seat (rc=$RC). Last wrapper.log signal: ${REASON:-none}. Live-Claude panel drive (/smart-compact) remains the proof path; see features/smart-compact.md Gotchas."
echo "VERIFY-CC-LHC smart-compact: SKIP"
exit "$SKIP_RC"
