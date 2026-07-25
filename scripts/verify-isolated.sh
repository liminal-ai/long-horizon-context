#!/usr/bin/env bash
# Launch a verifier in an ISOLATED copy of the fork tree.
#
# Why this exists
# ---------------
# Through Chunk 2, both verifiers were launched with cwd=/srv/work/grok-build —
# the same working tree, at the same time. Verifier mandates include mutation
# testing (break the code, watch the test fail, restore), so two verifiers were
# concurrently editing and reverting the same files. Consequences, all real:
#
#   1. Measurements taken during an overlap are unattributable — a suite run
#      may have included the other verifier's in-flight edits.
#   2. "Do not consult the other verifier" is unenforceable at the filesystem
#      level: one verifier read the other's test names and bodies off disk.
#      Convergence between lanes is then corroboration, not two independent
#      samples — which is the entire point of dual verification.
#   3. A verifier restoring "its" backup can silently delete the other's
#      in-flight work, or resurrect deleted work.
#
# Usage: verify-isolated.sh <lane> <brief-path> <sol|opus>
#   lane: short tag used for the copy directory, e.g. r14-sol
#
# Prints the run id on stdout. The copy is left in place for post-hoc
# inspection; remove it once the report is read.
set -euo pipefail

LANE="${1:?lane tag required}"
BRIEF="${2:?brief path required}"
MODEL="${3:?sol|opus required}"

SRC=/srv/work/grok-build
DST="/srv/work/grok-verif-${LANE}"

if [ ! -f "$BRIEF" ]; then echo "brief not found: $BRIEF" >&2; exit 1; fi
if [ -e "$DST" ]; then echo "destination exists, refusing to clobber: $DST" >&2; exit 1; fi

# Copy the whole tree including the vendored submodule and build artifacts.
# --delete is deliberately absent: DST must not exist, checked above.
rsync -a --exclude='.git/index.lock' "$SRC/" "$DST/"

# Record provenance so a report can be attributed to an exact tree state.
{
  echo "isolated verifier tree"
  echo "lane:    $LANE"
  echo "source:  $SRC"
  echo "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "git:     $(git -C "$SRC" rev-parse HEAD)"
  echo "dirty:   $(git -C "$SRC" status --short | wc -l) modified paths"
} > "$DST/ISOLATED-TREE.txt"

cd "$DST"
case "$MODEL" in
  sol)
    codex-subagent start --prompt-file "$BRIEF" \
      -m gpt-5.6-sol -c model_reasoning_effort=medium --sandbox danger-full-access
    ;;
  opus)
    claude-subagent start --prompt-file "$BRIEF" \
      --model claude-opus-5 --effort high
    ;;
  *) echo "unknown model: $MODEL" >&2; exit 1 ;;
esac
