#!/usr/bin/env bash
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
fail=0
note() { echo "doctor: $1"; }
bad() { echo "doctor: FAIL $1"; fail=1; }

command -v node >/dev/null 2>&1 || bad "node not on PATH"
if command -v node >/dev/null 2>&1; then
  ver="$(node -p 'process.versions.node')"
  note "node $ver"
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=3)?0:1)' \
    || bad "node >=24.3.0 required by packages/claude-lhc/package.json engines"
fi

ENTRY="$REPO/packages/claude-lhc/dist/sidecar.js"
if [ -f "$ENTRY" ]; then
  note "built sidecar present: packages/claude-lhc/dist/sidecar.js"
else
  bad "packages/claude-lhc/dist/sidecar.js missing; build: pnpm install --frozen-lockfile && pnpm --filter lhc build && pnpm --filter claude-lhc build"
fi

for f in packages/claude-lhc/src/protocol.ts packages/claude-lhc/src/session.ts packages/claude-lhc/src/sidecar.ts; do
  [ -f "$REPO/$f" ] || bad "missing source $f"
done

if command -v claude >/dev/null 2>&1; then
  note "claude binary: $(command -v claude) ($(claude --version 2>/dev/null | head -1))"
else
  note "WARN claude binary not on PATH; deterministic drives still run, the live turn drive cannot"
fi

note "isolation: drives set T3CODE_LHC_HOME, CLAUDE_CONFIG_DIR, cwd to fresh tmp dirs and T3CODE_LHC_NO_INFERENCE=1"
note "real homes untouched by deterministic drives (default LHC home ~/.t3code-lhc, Claude home ~/.claude)"

if [ "$fail" -eq 0 ]; then
  echo "VERIFY-CLAUDE-LHC doctor: PASS worth driving"
else
  echo "VERIFY-CLAUDE-LHC doctor: FAIL not worth driving yet"
fi
exit "$fail"
