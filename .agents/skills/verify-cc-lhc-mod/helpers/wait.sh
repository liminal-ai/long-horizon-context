#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"
wait_for "${3:-60}" "$2" "$1"/lhc/logs/*.log "$1"/debug-*.log
