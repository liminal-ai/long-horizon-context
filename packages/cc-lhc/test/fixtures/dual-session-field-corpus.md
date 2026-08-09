# Dual session-field corpus (Slice 1 acceptance blocker)

Date: 2026-08-09  
Supported Claude Code versions exercised: **2.1.215**, **2.1.220**, **2.1.226**

## Census command (reproducible)

```bash
python3 - <<'PY'
import json
from pathlib import Path
from collections import Counter
root = Path.home() / ".claude" / "projects"
files = lines = both_diff = both_same = only_camel = only_snake = 0
versions = Counter()
for p in root.rglob("*.jsonl"):
    try:
        if p.stat().st_size > 50_000_000:
            continue
    except OSError:
        continue
    files += 1
    with open(p, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            lines += 1
            sid, sn = o.get("sessionId"), o.get("session_id")
            if sid and sn:
                if sid != sn:
                    both_diff += 1
                    versions[str(o.get("version") or "?")] += 1
                else:
                    both_same += 1
            elif sid:
                only_camel += 1
            elif sn:
                only_snake += 1
print({"files": files, "lines": lines, "both_diff": both_diff,
       "both_same": both_same, "only_camel": only_camel, "only_snake": only_snake})
print("versions_with_diff", versions.most_common())
PY
```

## Reported production counts (verifier host)

| Metric | Count |
|--------|------:|
| Rollout files scanned | 4,173 |
| Parsed lines | 128,125 |
| Lines with **both** fields and **different** values | 8,202 |
| Concentration | Claude Code **2.1.215** and **2.1.220** |

## Representative shape (sanitized)

- Filename / current session (`sessionId`): `03c76ca8-427f-4a12-82c2-74496ed92c02`
- Origin/source retained on later lines (`session_id`): `6ea2a00a-fbf9-40c6-96c8-8e8d737593c4`
- Fixture: `rollout-samples-slice1.jsonl` (`fork-dual-session-line`, `fork-dual-session-asst`)

## Supported-version conclusion

1. **`sessionId` (camelCase) is current-session attribution** when present. The
   rollout filename is expected to match this id under deterministic capture.
2. **`session_id` (snake_case) is current attribution only when `sessionId` is
   absent** (older/single-field shapes).
3. **When both exist and differ**, `session_id` is **origin/lineage evidence**
   (fork/resume source). It is **not** a current-session conflict and must not
   latch capture degradation by itself.
4. **True conflict** is only `sessionId` (or sole `session_id` when camelCase is
   absent) disagreeing with the expected filename session id.

Parsers must not regress to “any session* field equals current session.”

## Housekeeping types co-observed (meta, not unknown)

`mode`, `system` / `system`+`turn_duration`, `permission-mode`,
`file-history-delta`, `agent-name` (plus prior meta set).
