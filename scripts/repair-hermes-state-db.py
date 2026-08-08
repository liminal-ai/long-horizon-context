#!/usr/bin/env python3
"""Clear re-captured LHC band content from a Hermes state.db.

Companion to the capture fix (d005bc8 / 8d7faa5) and the LHC thread
repair. Those stop the loop and clean LHC's record; this cleans Hermes'
own message store, which held the same band text a second time.

Targets only rows that are BOTH inactive and compacted and contain an LHC
band marker. Those are LHC's own compacted output, already summarised away
by a later compaction and unreachable from the live context. The canonical
record for that content is the LHC thread, so replacing it with a marker
loses nothing.

Never touches active rows: the bands in the current context are live and
are what the model is reading.

Content is replaced with a marker rather than emptied so the store shows a
repair happened instead of a silent gap. The messages_fts index follows via
the existing update triggers.

Run with --apply to mutate. Default is a dry run. Refuses while a Hermes
process holds the database open.
"""
import argparse
import os
import sqlite3
import sys

MARKER = (
    "[removed by repair] LHC compacted-band output that was mis-captured as a "
    "user prompt; the canonical record is in the LHC thread. See d005bc8."
)

SELECT = """
    select count(*), coalesce(sum(length(content)), 0)
    from messages
    where active = 0 and compacted = 1 and content like '%[context ·%'
"""

UPDATE = """
    update messages set content = ?
    where active = 0 and compacted = 1 and content like '%[context ·%'
"""


def holders(db_path):
    """Pids with the database open. Transient shells can vanish mid-scan and
    other users' processes are not inspectable; neither can hold a file under
    this user's home, so both are skipped rather than treated as fatal."""
    found = []
    for pid in os.popen("pgrep -f 'hermes --profile' 2>/dev/null").read().split():
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                if os.path.basename(db_path) in os.readlink(f"/proc/{pid}/fd/{fd}"):
                    found.append(pid)
                    break
            except OSError:
                pass
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("state_db")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    ro = sqlite3.connect(f"file:{a.state_db}?mode=ro", uri=True)
    n, chars = ro.execute(SELECT).fetchone()
    live = ro.execute(
        "select count(*) from messages where active = 1 and content like '%[context ·%'"
    ).fetchone()[0]
    total = ro.execute("select coalesce(sum(length(content)), 0) from messages").fetchone()[0]
    ro.close()

    print(f"inactive+compacted band rows: {n}")
    print(f"  content to reclaim: {chars:,} chars of {total:,} total")
    print(f"  active band rows (never touched): {live}")

    if not a.apply:
        print("\nDRY RUN — nothing changed. Re-run with --apply.")
        return

    held = holders(a.state_db)
    if held:
        sys.exit(f"REFUSING: pid(s) {','.join(held)} hold this database open. Stop Hermes first.")

    db = sqlite3.connect(a.state_db)
    db.execute("PRAGMA busy_timeout=10000")
    try:
        cur = db.execute(UPDATE, (MARKER,))
        db.commit()
        print(f"\nrows updated: {cur.rowcount}")
        after = db.execute("select coalesce(sum(length(content)), 0) from messages").fetchone()[0]
        print(f"store content: {total:,} -> {after:,} chars")
        still = db.execute(
            "select count(*) from messages where active = 1 and content like '%[context ·%'"
        ).fetchone()[0]
        print(f"active band rows intact: {still}")
    finally:
        db.close()

    print("\nRun VACUUM separately to reclaim file size.")


if __name__ == "__main__":
    main()
