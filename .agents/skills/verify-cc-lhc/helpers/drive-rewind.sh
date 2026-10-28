#!/usr/bin/env bash
# User-only: the replies and `rollout write` output. Outcome: the Claude transcript
# keeps both branches, wrapper.log records the rewind, and a forced rebuild of the
# served view holds the kept branch only. Exit 3 means this build has no rewind capture.
set -u
. "$(dirname "$0")/lib.sh"
make_isolation
KEEP_SEED="REWIND-KEEP-1"
KEEP_LIVE="REWIND-KEEP-2"
DROP="REWIND-DROP-3"
NEW="REWIND-NEW-4"

SEED_OUT="$(iso_env node "$SKILL_DIR/helpers/seed-thread.mjs" "$REPO_ROOT" "$ISO_HOME/.cc-lhc" "$ISO_HOME/work" "$KEEP_SEED" 2>"$EVIDENCE_DIR/rewind-seed.err")"
THREAD_ID="$(echo "$SEED_OUT" | awk '{print $1}')"
[ -n "$THREAD_ID" ] || { fail "seed failed: $(cat "$EVIDENCE_DIR/rewind-seed.err")"; finish rewind; exit 1; }
ENV="HOME='$ISO_HOME' CC_LHC_HOME='$ISO_HOME/.cc-lhc' CLAUDE_CONFIG_DIR='$ISO_HOME/.claude' CC_LHC_CLAUDE_BIN='$STANDIN'"
ENVELOPE="$REPO_ROOT/packages/cc-lhc/test/fixtures/claude-2.1.226-custom-title.jsonl"
SID="$(new_uuid)"
RC="$(run_in_tmux rewind-write "$EVIDENCE_DIR/rewind-write.log" \
  "$ENV node '$CC_LHC_BIN_JS' rollout write --thread-id $THREAD_ID --session-id $SID --token-family claude-2026 --cwd '$ISO_HOME/work' --envelope-from '$ENVELOPE'")" || RC=124
[ "$RC" = "0" ] || { fail "precondition rollout write rc=$RC"; finish rewind; exit 1; }
pass "precondition: seeded thread $THREAD_ID rebuilt into session $SID"

turn() {
  local name="$1" prompt="$2" extra="${3:-}"
  local rc
  rc="$(run_in_tmux "rewind-$name" "$EVIDENCE_DIR/rewind-$name.log" \
    "$extra $ENV node '$CC_LHC_BIN_JS' --lhc-no-inference --resume $SID -p '$prompt'")" || rc=124
  [ "$rc" = "0" ] && grep -qx ok "$EVIDENCE_DIR/rewind-$name.log" \
    && pass "$name: reply 'ok' for '$prompt'" || fail "$name rc=$rc (see rewind-$name.log)"
}
turn keep "$KEEP_LIVE live turn"
turn drop "$DROP turn the user rewinds away"
turn new "$NEW prompt after the rewind" "ONESHOT_CLAUDE_REWIND=1"

TRANSCRIPT="$(find "$ISO_HOME/.claude/projects" -name "$SID.jsonl" | head -1)"
cp "$TRANSCRIPT" "$EVIDENCE_DIR/rewind-transcript.jsonl"
cp "$ISO_HOME/.cc-lhc/wrapper.log" "$EVIDENCE_DIR/rewind-wrapper.log" 2>/dev/null || true
grep -q "$DROP" "$TRANSCRIPT" && pass "Claude transcript keeps the rewound branch on disk" || fail "transcript lost $DROP"
node -e '
  const fs=require("fs");const [f,drop,neu]=process.argv.slice(1);
  const rows=fs.readFileSync(f,"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));
  const prompt=(m)=>rows.find(r=>r.type==="user"&&String(r.message?.content).startsWith(m));
  process.exit(prompt(neu).parentUuid===prompt(drop).parentUuid?0:1);' "$TRANSCRIPT" "$DROP" "$NEW" \
  && pass "the new prompt's parent is the record before $DROP (a rewind hop)" || fail "transcript has no rewind hop"
if grep -q "cc-lhc rewind:" "$EVIDENCE_DIR/rewind-wrapper.log"; then
  pass "wrapper.log: $(grep -o 'cc-lhc rewind:.*' "$EVIDENCE_DIR/rewind-wrapper.log" | tail -1)"
fi
grep -q "capture degraded" "$EVIDENCE_DIR/rewind-wrapper.log" && fail "capture degraded (see rewind-wrapper.log)"

REBUILT_SID="$(new_uuid)"
RC="$(run_in_tmux rewind-rebuild "$EVIDENCE_DIR/rewind-rebuild.log" \
  "$ENV node '$CC_LHC_BIN_JS' rollout write --thread-id $THREAD_ID --session-id $REBUILT_SID --token-family claude-2026 --cwd '$ISO_HOME/work' --envelope-from '$ENVELOPE'")" || RC=124
REBUILT="$(find "$ISO_HOME/.claude/projects" -name "$REBUILT_SID.jsonl" | head -1)"
[ "$RC" = "0" ] && [ -n "$REBUILT" ] && pass "forced rebuild wrote session $REBUILT_SID" \
  || { fail "forced rebuild rc=$RC"; finish rewind; exit 1; }
cp "$REBUILT" "$EVIDENCE_DIR/rewind-rebuilt.jsonl"

echo "served view after the rewind (rebuilt session, in order):"
for marker in "$KEEP_SEED" "$KEEP_LIVE" "$DROP" "$NEW"; do
  if grep -q "$marker" "$REBUILT"; then echo "  served   $marker"; else echo "  hidden   $marker"; fi
done | tee "$EVIDENCE_DIR/rewind-served.txt"
for marker in "$KEEP_SEED" "$KEEP_LIVE" "$NEW"; do
  grep -q "$marker" "$REBUILT" && pass "rebuild keeps $marker" || fail "rebuild lost kept $marker"
done
if grep -q "$DROP" "$REBUILT"; then
  if [ "$FAILURES" -eq 0 ] && ! grep -q "cc-lhc rewind:" "$EVIDENCE_DIR/rewind-wrapper.log"; then
    echo "NOTE: both branches served; this build does not capture Claude rewind"
    echo "VERIFY-CC-LHC rewind: UNSUPPORTED"
    exit "$SKIP_RC"
  fi
  fail "rebuild still serves discarded $DROP"
else
  pass "rebuild holds no discarded text"
fi
finish rewind
