#!/bin/zsh
# Checkpoint every thread db's WAL into the main file, then commit and push.
# Run when no pi-lhc session is up for a clean snapshot; a mid-session run
# yields a slightly stale (not corrupt) copy.
set -e
cd "$(dirname "$0")"
for db in registry.sqlite threads/*.sqlite; do
  [ -f "$db" ] && sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
done
git add -A
if git diff --cached --quiet; then
  echo "pi-lhc-backup: nothing new"
else
  git commit -q -m "backup $(date '+%Y-%m-%d %H:%M')"
  git push -q origin main
  echo "pi-lhc-backup: pushed $(git rev-parse --short HEAD)"
fi
