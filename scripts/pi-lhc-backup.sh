#!/usr/bin/env bash
# Checkpoint every thread db's WAL into the main file, then commit and push.
# Run when no pi-lhc session is up for a clean snapshot; a mid-session run
# yields a slightly stale (not corrupt) copy.
set -euo pipefail
cd "$(dirname "$0")"

node --input-type=module <<'NODE'
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const files = ["registry.sqlite"];
if (existsSync("threads")) {
  for (const name of readdirSync("threads")) {
    if (name.endsWith(".sqlite")) files.push(join("threads", name));
  }
}

for (const file of files) {
  if (!existsSync(file)) continue;
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
NODE

git add -A
if git diff --cached --quiet; then
  echo "pi-lhc-backup: nothing new"
else
  git commit -q -m "backup $(date '+%Y-%m-%d %H:%M')"
  git push -q origin main
  echo "pi-lhc-backup: pushed $(git rev-parse --short HEAD)"
fi
