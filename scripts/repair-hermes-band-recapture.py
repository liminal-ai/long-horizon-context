#!/usr/bin/env python3
"""Repair a Hermes LHC thread that re-captured its own compacted bands.

Replaces each band message that was mis-recorded as a user prompt with a
short marker. Editing (not deleting) is deliberate and forced: message
delete refuses turn-initiating prompts, and every one of these opens its
turn. Edit has no such refusal and runs the same cascade — the message's
own derivation drops, its turn and chunk clear and re-queue, and the
background drain rebuilds them from the corrected, much smaller input.

Selection is structural where it can be: only user_prompt messages whose
stored text is an LHC-rendered band. The band prefix is used to FIND
already-corrupted rows in storage; it is not used to classify live
messages (see capture.py — that path keys on source_messages).

Run with --apply to mutate. Default is a dry run.

PREREQUISITE: no Hermes process may hold the thread open, and it must be
running the capture fix (d005bc8). Repairing while an old-code process is
attached re-injects on its next compaction.
"""
import argparse, asyncio, os, sqlite3, sys

MARKER = ("[removed by repair] LHC compacted-band output that was "
          "mis-captured as a user prompt; see capture fix d005bc8")


def find_targets(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    rows = c.execute("""
        select m.message_id, m.turn_id, t.status, length(b.content)
        from message m
        join message_block b using(message_id)
        join turns t on t.turn_id = m.turn_id
        where m.kind='user_prompt'
          and m.deleted_at is null
          and (b.content like '%[context · brief]%'
            or b.content like '%[context · smooth]%'
            or b.content like '%[context · detailed]%')
        order by m.source_event_order""").fetchall()
    c.close()
    return rows


async def repair(path, targets):
    sys.path.insert(0, "/srv/work/long-horizon-context/packages/lhc-py/src")
    from lhc.sdk import init_lhc
    from lhc.messages import EditInput
    sdk = init_lhc({"mode": "manual"})
    ref = {"filePath": path}
    ok = failed = 0
    for mid, turn, status, size in targets:
        res = await sdk.messages.edit(ref, EditInput(message_id=mid, content=MARKER))
        if getattr(res, "ok", False):
            ok += 1
            ch = getattr(res.value, "cleared", []) or []
            print(f"  edited {mid} ({turn}, {size:,} chars) -> cleared {len(ch)} derivations")
        else:
            failed += 1
            print(f"  FAILED {mid} ({turn}): {getattr(res, 'error', '?')}")
    return ok, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("thread")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    targets = find_targets(a.thread)
    closed = [t for t in targets if t[2] == "closed"]
    blocked = [t for t in targets if t[2] != "closed"]
    total = sum(t[3] for t in targets)

    print(f"band messages mis-captured as user prompts: {len(targets)}")
    print(f"  editable now (closed turn): {len(closed)}")
    print(f"  blocked (open turn):        {len(blocked)}")
    for t in blocked:
        print(f"     {t[0]} in {t[1]} ({t[2]}) — retry after the turn closes")
    print(f"  content to reclaim: {total:,} chars")

    if not a.apply:
        print("\nDRY RUN — nothing changed. Re-run with --apply.")
        for mid, turn, status, size in closed[:5]:
            print(f"   would edit {mid} ({turn}) {size:,} chars -> {len(MARKER)} chars")
        if len(closed) > 5:
            print(f"   ... and {len(closed)-5} more")
        return

    for p in os.popen("pgrep -f 'hermes --profile' 2>/dev/null").read().split():
        if os.path.exists(f"/proc/{p}/fd"):
            for fd in os.listdir(f"/proc/{p}/fd"):
                try:
                    if os.path.basename(a.thread) in os.readlink(f"/proc/{p}/fd/{fd}"):
                        sys.exit(f"REFUSING: pid {p} holds this thread open. Stop it first.")
                except OSError:
                    pass

    ok, failed = asyncio.run(repair(a.thread, closed))
    print(f"\nedited {ok}, failed {failed}. Derivations rebuild in the background drain.")


if __name__ == "__main__":
    main()
