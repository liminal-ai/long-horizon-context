#!/usr/bin/env bash
set -u
. "$(dirname "$0")/lib.sh"
ok=1
need() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; ok=0; fi; }
need "node >= 24" '[ "$(node -p "process.versions.node.split(\".\")[0]")" -ge 24 ]'
need "tmux" 'command -v tmux'
need "claude on PATH ($(claude --version 2>/dev/null))" 'command -v claude'
need "built plugin at $PLUGIN" '[ -f "$PLUGIN/hooks/register.js" ] && [ -f "$PLUGIN/sidecar/main.js" ]'
need "claude plugin validate" 'claude plugin validate "$PLUGIN"'
need "scratch root outside any repo ($SCRATCH_ROOT)" '! git -C "$SCRATCH_ROOT" rev-parse 2>/dev/null'
[ "$ok" = 1 ] && echo "VERIFY-CC-LHC-MOD doctor: PASS" || { echo "VERIFY-CC-LHC-MOD doctor: FAIL"; exit 1; }
