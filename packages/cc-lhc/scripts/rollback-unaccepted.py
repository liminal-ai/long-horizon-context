#!/usr/bin/env python3
"""Run once after rolling cc-lhc back from 0.4.3 (or later) to 0.4.2.

0.4.3 records a Smart Compact rebuild as `rebuild_unaccepted=1` before it
writes the file. 0.4.2 does not know that column: a 0.4.2 launch that names
such a session imports the thread's lineage and makes its newest row, the
never-accepted rebuild, the thread's current session. This removes those rows
and moves their transcripts into <home>/abandoned-rebuilds/, so 0.4.2 sees
nothing to promote. Rows whose thread has a live owner lease (a compaction in
flight) are left alone; run again once that session exits.

Usage: rollback-unaccepted.py [--home DIR] [--projects DIR] [--apply]
--home defaults to $CC_LHC_HOME, else ~/.cc-lhc; --projects to
$CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. Default is a dry run.
"""

import argparse
import glob
import json
import os
import shutil
import sqlite3
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--home", default=os.environ.get("CC_LHC_HOME") or os.path.expanduser("~/.cc-lhc"))
ap.add_argument(
    "--projects",
    default=os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects"),
)
ap.add_argument("--apply", action="store_true")
args = ap.parse_args()


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        # os.kill(pid, 0) sends CTRL_C_EVENT on Windows; ask the kernel instead.
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.GetLastError() == 5  # access denied: exists
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


live_threads = set()
for lease in glob.glob(os.path.join(args.home, "owners", "*.json")):
    try:
        owner = json.load(open(lease))
        if pid_alive(int(owner["processIdentity"]["pid"])):
            live_threads.add(owner["threadId"])
    except Exception:
        # Unreadable lease: treat as live (keep).
        live_threads.add(None)

db = os.path.join(args.home, "cc-lhc.sqlite")
if not os.path.exists(db):
    print("no lineage db:", db)
    raise SystemExit(0)
con = sqlite3.connect(db)
cols = [r[1] for r in con.execute("pragma table_info(cc_session_lineage)")]
if "rebuild_unaccepted" not in cols:
    print("no rebuild_unaccepted column: 0.4.3 never migrated this db; nothing to do")
    raise SystemExit(0)
rows = con.execute(
    "select rollout_session_id, thread_id from cc_session_lineage where rebuild_unaccepted = 1"
).fetchall()
if not rows:
    print("no unaccepted rows; rollback is safe as is")
for session_id, thread_id in rows:
    if thread_id in live_threads or None in live_threads:
        print(f"KEEP  {session_id} thread {thread_id}: owner lease live or unreadable")
        continue
    files = glob.glob(os.path.join(args.projects, "*", f"{session_id}.jsonl"))
    print(f"{'DROP ' if args.apply else 'would drop'} {session_id} thread {thread_id} files={files}")
    if not args.apply:
        continue
    for f in files:
        dest_dir = os.path.join(args.home, "abandoned-rebuilds", os.path.basename(os.path.dirname(f)))
        os.makedirs(dest_dir, exist_ok=True)
        shutil.move(f, os.path.join(dest_dir, os.path.basename(f)))
    con.execute("delete from cc_session_lineage where rollout_session_id = ?", (session_id,))
    con.commit()
