#!/usr/bin/env bash
# Doctor: ONE read-only worth-driving check. Touches no operator state:
# --lhc-version/--lhc-help launch no Claude and run under a throwaway HOME.
set -u
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

node_ok() {
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=3)?0:1)' 2>/dev/null
}

command -v node >/dev/null && node_ok \
  && pass "node $(node --version) (>= 24.3)" \
  || fail "node >= 24.3 required, found: $(node --version 2>/dev/null || echo missing)"

command -v tmux >/dev/null && pass "tmux present ($(tmux -V))" || fail "tmux missing"

if command -v claude >/dev/null; then
  pass "claude present ($(claude --version 2>/dev/null | head -1)); live drives still need throwaway-HOME auth"
else
  skip "claude binary absent; stand-in drives only"
fi

[ -f "$CC_LHC_BIN_JS" ] && pass "built wrapper at packages/cc-lhc/dist/bin.js" \
  || fail "packages/cc-lhc/dist/bin.js missing -- run the SKILL.md Launch build"

ADDON="$(ls "$REPO_ROOT"/packages/cc-lhc-native/prebuilds/*/cc_lhc_identity.node "$REPO_ROOT"/packages/cc-lhc-native/build/Release/cc_lhc_identity.node 2>/dev/null | head -1)"
[ -n "$ADDON" ] && pass "native identity addon present ($ADDON)" \
  || fail "native identity addon missing -- every real launch exits 2 (build:native + stage:prebuild, see Launch)"

[ -x "$STANDIN" ] || chmod +x "$STANDIN" 2>/dev/null || true
[ -f "$STANDIN" ] && pass "stand-in Claude fixture present (test/fixtures/oneshot-claude.mjs)" \
  || fail "stand-in fixture missing: $STANDIN"

if [ -f "$CC_LHC_BIN_JS" ]; then
  make_isolation
  VER_OUT="$(iso_env node "$CC_LHC_BIN_JS" --lhc-version 2>&1)"; VER_RC=$?
  { [ "$VER_RC" -eq 0 ] && echo "$VER_OUT" | grep -q '^cc-lhc '; } \
    && pass "--lhc-version under isolated HOME: $(echo "$VER_OUT" | head -1)" \
    || fail "--lhc-version failed rc=$VER_RC: $VER_OUT"
  echo "$VER_OUT" >"$EVIDENCE_DIR/doctor-version.txt"
  rm -rf "$ISO_HOME"
fi

finish doctor
