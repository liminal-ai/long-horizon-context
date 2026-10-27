#!/usr/bin/env bash
# Seeded drive: rebuild a thread into a fresh Claude session and continue it.
# Precondition seeding (seed-thread.mjs) creates a settled thread via the
# lhc SDK, exactly as test/commands/rollout-write.test.ts does; the DRIVE
# is the real CLI surface: `cc-lhc rollout write` (the rebuilt-rollout
# writer Smart Compact uses), then `--resume <new-id> -p` via the wrapper.
# User-only check: resume the rebuilt session; it answers.
# Outcome check: rebuilt JSONL carries the seeded history under the NEW
# session id, lineage is registered, and the resumed transcript grows
# without re-intaking the replayed prefix as a degraded capture.
set -u
. "$(dirname "$0")/lib.sh"
make_isolation
chmod +x "$STANDIN" 2>/dev/null || true
CODEWORD="ALDER-7"

SEED_OUT="$(iso_env node "$SKILL_DIR/helpers/seed-thread.mjs" "$REPO_ROOT" "$ISO_HOME/.cc-lhc" "$ISO_HOME/work" "$CODEWORD" 2>"$EVIDENCE_DIR/rebuild-seed.err")"
THREAD_ID="$(echo "$SEED_OUT" | awk '{print $1}')"
[ -n "$THREAD_ID" ] && pass "seeded thread $THREAD_ID (precondition, not proof)" \
  || { fail "seed failed: $(cat "$EVIDENCE_DIR/rebuild-seed.err")"; finish rebuild; exit 1; }

NEW_SID="$(new_uuid)"
echo "$NEW_SID" >"$EVIDENCE_DIR/rebuild-session-id.txt"
LOG="$EVIDENCE_DIR/rebuild.log"
ENV="HOME='$ISO_HOME' CC_LHC_HOME='$ISO_HOME/.cc-lhc' CLAUDE_CONFIG_DIR='$ISO_HOME/.claude' CC_LHC_CLAUDE_BIN='$STANDIN'"
RC="$(run_in_tmux rebuild "$LOG" \
  "$ENV node '$CC_LHC_BIN_JS' rollout write --thread-id $THREAD_ID --session-id $NEW_SID --token-family claude-2026 --cwd '$ISO_HOME/work' --envelope-from '$REPO_ROOT/packages/cc-lhc/test/fixtures/claude-2.1.226-custom-title.jsonl'")" || RC=124

[ "$RC" = "0" ] && pass "rollout write exited 0" || fail "rollout write rc=$RC (see rebuild.log)"
REBUILT="$(find "$ISO_HOME/.claude/projects" -name "$NEW_SID.jsonl" 2>/dev/null | head -1)"
[ -n "$REBUILT" ] && pass "rebuilt rollout written: $REBUILT" || fail "rebuilt rollout $NEW_SID.jsonl missing"
if [ -n "$REBUILT" ]; then
  grep -q "$CODEWORD" "$REBUILT" && pass "rebuilt session answers from seeded history (codeword present)" \
    || fail "seeded history missing from rebuilt rollout"
  node -e '
    const fs=require("fs");const [f,sid]=process.argv.slice(1);
    const lines=fs.readFileSync(f,"utf8").split("\n").filter(Boolean);
    const bad=lines.filter(l=>{try{return JSON.parse(l).sessionId!==sid}catch{return true}});
    console.log(`lines=${lines.length} wrong_session=${bad.length}`);
    process.exit(lines.length>0&&bad.length===0?0:1);' "$REBUILT" "$NEW_SID" >"$EVIDENCE_DIR/rebuild-lines.txt" \
    && pass "every rebuilt line carries the new session id ($(cat "$EVIDENCE_DIR/rebuild-lines.txt"))" \
    || fail "rebuilt lines malformed: $(cat "$EVIDENCE_DIR/rebuild-lines.txt")"
  BEFORE="$(wc -l <"$REBUILT")"
  cp "$REBUILT" "$EVIDENCE_DIR/rebuild-rollout.jsonl"

  RLOG="$EVIDENCE_DIR/rebuild-resume.log"
  RRC="$(run_in_tmux rebuild-resume "$RLOG" \
    "$ENV node '$CC_LHC_BIN_JS' --lhc-no-inference --resume $NEW_SID -p 'continue: repeat the codeword'")" || RRC=124
  [ "$RRC" = "0" ] && pass "resume of rebuilt session exited 0" || fail "resume rc=$RRC (see rebuild-resume.log)"
  AFTER="$(wc -l <"$REBUILT")"
  [ "$AFTER" -gt "$BEFORE" ] && pass "rebuilt transcript continued ($BEFORE -> $AFTER lines)" \
    || fail "rebuilt transcript did not grow ($BEFORE -> $AFTER)"
  if grep -q "capture degraded" "$ISO_HOME/.cc-lhc/wrapper.log" 2>/dev/null; then
    fail "resume degraded capture (see rebuild wrapper.log in evidence)"
  else
    pass "no capture degradation on rebuilt-session resume"
  fi
  cp "$ISO_HOME/.cc-lhc/wrapper.log" "$EVIDENCE_DIR/rebuild-wrapper.log" 2>/dev/null || true
fi

finish rebuild
