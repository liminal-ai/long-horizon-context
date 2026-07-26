#!/usr/bin/env python3
"""Canonical dump of an LHC thread sqlite file with the two sanctioned
variables masked: thread id and server-stamped timestamps."""
import re, sqlite3, sys

ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
SANCTIONED_TS = ("recorded_at", "created_at", "updated_at", "enqueued_at", "available_at", "claimed_at", "completed_at", "derived_at")

def dump(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cur = con.cursor()
    tid = None
    try:
        tid = cur.execute("SELECT thread_id FROM thread_metadata LIMIT 1").fetchone()[0]
    except Exception:
        pass
    out = []
    out.append(f"user_version={cur.execute('PRAGMA user_version').fetchone()[0]}")
    tables = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    for t in tables:
        cols = [(r[1], r[2]) for r in cur.execute(f"PRAGMA table_info({t})")]
        schema = cur.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()[0]
        out.append(f"== {t} :: {schema}")
        names = [c[0] for c in cols]
        for row in cur.execute(f"SELECT * FROM {t} ORDER BY rowid"):
            parts = []
            for name, val in zip(names, row):
                s = repr(val)
                if isinstance(val, str):
                    if tid and tid in val:
                        s = repr(val.replace(tid, "<TID>"))
                    if name in SANCTIONED_TS or name.endswith("_at"):
                        s = repr(ISO.sub("<TS>", val))
                    else:
                        # timestamps embedded in JSON payloads that came from
                        # the host (startedAt/endedAt literals) must NOT mask —
                        # only server-stamped fields do. JSON columns keep raw.
                        pass
                parts.append(f"{name}={s}")
            out.append("  " + " | ".join(parts))
    return "\n".join(out)

a, b = sys.argv[1], sys.argv[2]
da, db = dump(a), dump(b)
if da == db:
    print("BYTE-IDENTICAL after sanctioned masking")
    sys.exit(0)
import difflib
for line in list(difflib.unified_diff(da.splitlines(), db.splitlines(), "TS", "RUST", lineterm=""))[:60]:
    print(line)
sys.exit(1)
