#!/bin/zsh
# Gorilla-test fill, phase 3: fat paste + pure dialog turns on th_223371e0d9ed95bf.
set -uo pipefail
cd /Users/leemoore/code/pi-long-horizon/liminal-context
BIN="node packages/pi-lhc/dist/bin.js"
SCRATCH="/private/tmp/claude-501/-Users-leemoore-code-pi-long-horizon-liminal-context/2d2c1674-c26f-485b-8856-27b8a6c4e743/scratchpad/gorilla"
LOG="$SCRATCH/phase3.log"
TRACK="node $SCRATCH/track-tokens.mjs"
THREAD="--lhc-thread th_223371e0d9ed95bf"

: > "$LOG"

# Turn: fat prompt paste (simulates pasting a transcript/braindump — exercises smoothing on big input)
PASTE=$(cat docs/onboard/01-core-concepts.md docs/onboard/02-domain-design.md)
echo "=== TURN: fat-paste — $(date +%H:%M:%S) ===" >> "$LOG"
node /Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/dist/bin.js --lhc-thread th_223371e0d9ed95bf -a -p "here is a big braindump of design docs from another session, just absorb this and tell me in a few sentences whether anything in it contradicts what you learned reading the actual code. dont use any tools, just answer from what you know:

$PASTE" >> "$LOG" 2>&1
echo "--- exit: $? — $(date +%H:%M:%S) ---" >> "$LOG"
eval "$TRACK" >> "$LOG" 2>&1

# Two pure-dialog turns, tools disabled — clean material for dialog compression
echo "=== TURN: dialog-1 — $(date +%H:%M:%S) ===" >> "$LOG"
node /Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/dist/bin.js --lhc-thread th_223371e0d9ed95bf -a --no-tools -p "From everything you have absorbed: if you had to cut ONE domain from lhc and fold its responsibilities into the others, which would it be and why? Answer in dialogue, no tools." >> "$LOG" 2>&1
echo "--- exit: $? — $(date +%H:%M:%S) ---" >> "$LOG"

echo "=== TURN: dialog-2 — $(date +%H:%M:%S) ===" >> "$LOG"
node /Users/leemoore/code/pi-long-horizon/liminal-context/packages/pi-lhc/dist/bin.js --lhc-thread th_223371e0d9ed95bf -a --no-tools -p "Last question: what are the three biggest risks you see in this codebase as it heads toward an npm-published SDK consumed by a Claude Code wrapper? Short, direct answers." >> "$LOG" 2>&1
echo "--- exit: $? — $(date +%H:%M:%S) ---" >> "$LOG"
eval "$TRACK" >> "$LOG" 2>&1

echo "PHASE3 COMPLETE $(date +%H:%M:%S)" >> "$LOG"
grep -E "=== TURN|--- exit|visibleTokens" "$LOG"
