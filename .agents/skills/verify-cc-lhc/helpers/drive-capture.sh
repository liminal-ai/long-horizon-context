#!/usr/bin/env bash
set -u
. "$(dirname "$0")/lib.sh"
make_isolation

SID="$(new_uuid)"
CODEWORD="ALDER-7"
echo "$SID" >"$EVIDENCE_DIR/capture-session-id.txt"
LOG="$EVIDENCE_DIR/capture.log"
ENV="$(iso_cmd_env) CC_LHC_CLAUDE_BIN='$STANDIN'"
RC="$(run_in_tmux capture "$LOG" \
  "$ENV node '$CC_LHC_BIN_JS' --lhc-no-inference -p 'seed prompt: the codeword is $CODEWORD' --session-id $SID")" || RC=124

[ "$RC" = "0" ] && pass "one-shot capture drive exited 0" || fail "one-shot exited rc=$RC (see capture.log)"
grep -qx "ok" "$LOG" && pass "user-visible reply 'ok' on stdout" || fail "no 'ok' reply in capture.log"
grep -q "cc-lhc-capture" "$LOG" && pass "capture summary line printed" || fail "no cc-lhc-capture line"

TRANSCRIPT="$(find "$ISO_HOME/.claude/projects" -name "$SID.jsonl" 2>/dev/null | head -1)"
[ -n "$TRANSCRIPT" ] && pass "transcript written under throwaway HOME: $TRANSCRIPT" || fail "transcript $SID.jsonl not found under isolated HOME"
if [ -n "$TRANSCRIPT" ]; then
  grep -q "$CODEWORD" "$TRANSCRIPT" && pass "seeded prompt persisted in transcript" || fail "codeword missing from transcript"
  cp "$TRANSCRIPT" "$EVIDENCE_DIR/capture-transcript.jsonl"
fi
[ -f "$ISO_HOME/.cc-lhc/cc-lhc.sqlite" ] && pass "lineage DB created under CC_LHC_HOME" || fail "cc-lhc.sqlite missing"
[ -f "$ISO_HOME/.cc-lhc/registry.sqlite" ] && pass "registry DB created under CC_LHC_HOME" || fail "registry.sqlite missing"
ls "$ISO_HOME"/.cc-lhc/threads/*.sqlite >/dev/null 2>&1 && pass "thread store created" || fail "no thread sqlite under .cc-lhc/threads"
grep -q "cc-lhc owns thread" "$ISO_HOME/.cc-lhc/wrapper.log" 2>/dev/null \
  && pass "wrapper.log records thread ownership ($(grep -o 'owns thread [^ ]*' "$ISO_HOME/.cc-lhc/wrapper.log" | head -1))" \
  || fail "wrapper.log has no thread ownership line"
cp "$ISO_HOME/.cc-lhc/wrapper.log" "$EVIDENCE_DIR/capture-wrapper.log" 2>/dev/null || true

if find "$HOME/.claude/projects" -name "$SID.jsonl" 2>/dev/null | grep -q .; then
  fail "ISOLATION BREACH: transcript leaked into operator ~/.claude"
else
  pass "no transcript leaked into operator ~/.claude"
fi

finish capture
