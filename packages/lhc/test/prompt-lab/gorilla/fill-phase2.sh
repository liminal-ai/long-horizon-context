#!/bin/zsh
# Gorilla-test fill, phase 2: READMEs + deep dives (turns 5-9) on th_223371e0d9ed95bf.
set -uo pipefail
cd /Users/leemoore/code/pi-long-horizon/liminal-context
BIN="node packages/pi-lhc/dist/bin.js"
SCRATCH="/private/tmp/claude-501/-Users-leemoore-code-pi-long-horizon-liminal-context/2d2c1674-c26f-485b-8856-27b8a6c4e743/scratchpad/gorilla"
LOG="$SCRATCH/phase2.log"
TRACK="node $SCRATCH/track-tokens.mjs"
THREAD="--lhc-thread th_223371e0d9ed95bf"

run_turn () {
  local label="$1"; shift
  echo "=== TURN: $label — $(date +%H:%M:%S) ===" >> "$LOG"
  eval "$BIN $THREAD $1" >> "$LOG" 2>&1
  echo "--- exit: $? — $(date +%H:%M:%S) ---" >> "$LOG"
  eval "$TRACK" >> "$LOG" 2>&1
}

: > "$LOG"

run_turn "root-readme" "-a -p 'Based on everything you have learned onboarding this repo, write a README.md at the repo root. Cover: what Long Horizon Context is, the two packages and their relationship, the core concepts (record, derivations, turns, chunks, bands, smart compact, thread views), and how to build and test. Write it for a developer seeing the repo for the first time. Create the file.'"

run_turn "lhc-deep-dive" "-a -p 'Do a deeper dive on packages/lhc internals you have not fully absorbed yet: reread the trickiest parts — the work queue claim/epoch fencing, the cascade logic in messages/internal/cascade.ts, the compact selection algorithm in thread-view/internal/select.ts including coverage entries, and the migration code in thread-migrate.ts. Trace a message edit end to end through the cascade. Explain what you found in detail.'"

run_turn "lhc-readme" "-a -p 'Now write packages/lhc/README.md: the SDK surface (initLhc, the domain namespaces and their operations), the derivation pipeline with all current derivation types and what feeds what, the work queue and host modes, compact profiles and bands, and the OpResult error contract. Developer-facing, precise, create the file.'"

run_turn "pi-lhc-deep-dive" "-a -p 'Deeper dive on packages/pi-lhc: reread the capture converter and turn accumulator, the fork seeding paths in index.ts, the compact handler preflight chain, and the launcher session hydration. Trace one PI message from message_end hook to durable LHC rows. Explain the fail-closed guard design and where diagnostics go.'"

run_turn "pi-lhc-readme" "-a -p 'Write packages/pi-lhc/README.md: what the connector does, launcher usage and the --lhc flags, the hook rail and what each hook handles, compact bridging, the /lhc-rehydrate and /lhc-dump-view commands, inference bridging through PI, and known limitations. Create the file.'"

echo "PHASE2 COMPLETE $(date +%H:%M:%S)" >> "$LOG"
grep -E "=== TURN|--- exit|visibleTokens" "$LOG"
