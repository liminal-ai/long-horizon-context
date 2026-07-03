#!/bin/zsh
# Gorilla-test fill, phase 1: create thread + onboarding reads (turns 1-4).
set -uo pipefail
cd /Users/leemoore/code/pi-long-horizon/liminal-context
BIN="node packages/pi-lhc/dist/bin.js"
SCRATCH="/private/tmp/claude-501/-Users-leemoore-code-pi-long-horizon-liminal-context/2d2c1674-c26f-485b-8856-27b8a6c4e743/scratchpad/gorilla"
LOG="$SCRATCH/phase1.log"
TRACK="node $SCRATCH/track-tokens.mjs"

run_turn () {
  local label="$1"; shift
  echo "=== TURN: $label — $(date +%H:%M:%S) ===" >> "$LOG"
  eval "$BIN $1" >> "$LOG" 2>&1
  echo "--- exit: $? — $(date +%H:%M:%S) ---" >> "$LOG"
  eval "$TRACK" >> "$LOG" 2>&1
}

: > "$LOG"

# Turn 1 — creates the thread (no --lhc flags = new thread), git history onboarding
run_turn "git-history" "-a -p 'You are onboarding onto this repo. Go through the entire git history thoroughly: git log with stats, read the important commit messages across all 140+ commits, look at what was built in each phase, what got refactored or deleted, and the recent work. Produce a thorough development narrative of this project from first commit to HEAD. Be comprehensive — walk epochs, name commits, describe the arcs.'"

# Turns 2-4 — attach to that thread, read all the code
run_turn "lhc-domains" "--lhc-continue -a -p 'Continue onboarding. Read ALL of the source code in packages/lhc/src — every domain: threads, intake-stream, messages, turns, thread-view, inspect. Read every file fully, do not skim. As you go, describe what each module does and how the domains call each other. Be exhaustive.'"

run_turn "lhc-shared-tech" "--lhc-continue -a -p 'Continue onboarding. Now read ALL of packages/lhc/src/shared-tech — work queue, scheduler, inference adapter, prompts, token counting, logging, storage, view config, instance seam. Every file, fully. Explain the machinery: how the durable queue works, claim/epoch fencing, how prompts are registered, how the inference adapter routes.'"

run_turn "pi-lhc-code" "--lhc-continue -a -p 'Continue onboarding. Read ALL of packages/pi-lhc/src — capture, compact, inference, launcher, lifecycle, serving, commands, pi types. Every file fully. Explain how the connector hooks into PI, how events flow into LHC, how compact is bridged, how the launcher owns startup, and how context is served back.'"

echo "PHASE1 COMPLETE $(date +%H:%M:%S)" >> "$LOG"
tail -40 "$LOG"
