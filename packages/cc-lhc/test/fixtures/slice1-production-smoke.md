# Slice 1 production exhibits

Date: 2026-08-09  
Claude: `2.1.226 (Claude Code)`  
**Current certification: Exhibit C.10** (correction-10 artifact, hash-bound)

---

## Exhibit C.10 — Proven digest transferred into watcher ownership (hash-bound)

### Artifact manifest (sha256)

Built once before the exhibit; verified unchanged after:

```
a6c32805d8468d5c7bccb3fb3a5a63574a61ba0292173924533e5ee799de67eb  dist/bin.js
1653d9297d1ac47438487168e4f1612506a79669307a2836c0447cbb6083a64d  dist/wrapper/run.js
4a8005220c52ccdfda50606644e5660572ce60bde0656b46f854610732440754  dist/intake/launch-session.js
36a6675f6dd489e46cdc866ffb8e932ff6d1ee716b40277dc8c7df5ab46cd85c  dist/intake/lineage-db.js
3fc439c3235d799447a4da7765fc0f6c1265a28366a0f5727d3369092a24e7a3  dist/intake/session.js
43a57d19d2e7d2e8f70b863fa54468ffd2f4602cd96a5594eed7b1186ce1f964  dist/rollout/watcher.js
5ad58355f8c619311204af3a9a974f33687051a4856717bef391adbb6611d884  dist/intake/prefix-boundary.js
```

Manifest file: `/tmp/cc-lhc-slice1-c10-1786304194/dist-manifest.sha256`  
`sha256sum -c` (cwd `packages/cc-lhc`) → all OK after exhibit (no rebuild).

### Identities

| Field | Value |
|-------|--------|
| Smoke | `/tmp/cc-lhc-slice1-c10-1786304194` |
| Old session | `1b4c1d9e-99c1-449f-a5da-906e67f813d2` |
| Rebuilt session | `bdc858a9-df31-43cf-962f-d4b2964a920a` |
| Thread | `th_f6d185c02af404b8` |
| Boundary | `verified lines=3 bytes=1274 sha256=b6cb4e286b18e939e0b279ef0c34b76b086c60cb064d6da62c1a9695d14ad59b` |
| Band on disk | yes (`C10-BAND-MUST-NOT-ENTER`) |

### Commands

```bash
export CC_LHC_HOME=/tmp/cc-lhc-slice1-c10-1786304194/home
export CC_LHC_NO_INFERENCE=1
cd /tmp/cc-lhc-slice1-c10-1786304194/work
node /srv/work/long-horizon-context/packages/cc-lhc/dist/bin.js \
  --session-id 1b4c1d9e-99c1-449f-a5da-906e67f813d2 \
  -p "Reply exactly: c10-seed-1" --model sonnet
# multi-turn --resume seeds …
# writeRebuiltRollout + registerRebuiltSessionLineage (banded)
node …/dist/bin.js --resume bdc858a9-df31-43cf-962f-d4b2964a920a \
  -p "Reply with exactly: c10-verified-relaunch-ok" --model sonnet
```

### Canonical deltas

| Stage | Events | Notes |
|-------|-------:|--------|
| Pre-rebuild | **10** | 5 user + 5 assistant |
| Post-relaunch | **13** | delta **+3** (runtime_note + live user/assistant; no thinking this run) |
| Capture resume | `replayed_prefix=3 events=3` | |
| Band pollution | **false** | |
| Live pair in view | **true** (`c10-verified-relaunch-ok` prompt present) | |
| Live stdout | `c10-verified-relaunch-ok` | |
| Log | `prefix verified; watcher starts at byte 1274` | |

### Proven

- Hash-bound correction-10 `dist/` (session transfers proven sha256; watcher never re-baselines)
- Verified fence + coherent snapshot + owned digest path
- Served band never entered canonical thread
- Live resume captured on same durable thread

---

## Superseded exhibits (not current certification)

| Label | Path | Note |
|-------|------|------|
| C.9 | `/tmp/cc-lhc-slice1-c9-1786303858` | lacked digest transfer; handoff-gap re-baseline hole |
| C.8 | `/tmp/cc-lhc-slice1-c8-1786302994` | superseded |
| C.5 / C.1 | `/tmp/cc-lhc-slice1-r3-band-…` | historical only |

---

## Gates (correction 10)

```text
tsc -p tsconfig.json --noEmit
tsc -p tsconfig.test.json --noEmit
vitest run          # 40 files / 372 tests
tsc -p tsconfig.json  # single build for exhibit
git diff --check -- packages/cc-lhc
sha256sum -c dist-manifest (cwd packages/cc-lhc; after exhibit, no rebuild)
```
