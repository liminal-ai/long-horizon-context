# Signed-thinking rebuild ladder — Slice 1 evidence

Date: 2026-08-09  
Claude Code binary: `/home/leemoore/.local/bin/claude` version **2.1.226**  
Host: linux (workstation)

## Census of live rollouts

Scanned ~80 recent project rollouts under `~/.claude/projects/`.

| Thinking shape | Count (sample window) | Notes |
|----------------|----------------------|--------|
| empty text + non-empty signature | 253+ | Dominant shape (omitted-display) |
| non-empty text + signature | 0 in sample | Not observed in scanned set |
| non-empty text, no signature | 0 in sample | Not observed |
| empty text, no signature | rare | Serve-time husk |

Sanitized structural sample retained in `rollout-samples-slice1.jsonl` (`sanitized-uuid-thinking` and split assistant lines sharing `msg_sanitized_split_001`).

Usage on split assistant lines (same `message.id`) is **repeated** on thinking, text, and tool_use lines with identical `input_tokens` / cache fields. Lifecycle dedupe key: `message.id`.

## Native compact artifacts

No `type: "summary"` native compact lines were present in the scanned corpus at evidence time.  
No retained native-compact-then-reload exhibit proves Claude preserves prior thinking signatures across its own compact/reload path.

## Live rebuild/reload

A production-path smoke (capture + rebuild) is recorded separately under
`test/fixtures/slice1-production-smoke.md` after the suite is green.

## Selected arm

**`omit`** (arm 3 — pre-exhibit floor)

- Rebuild must not invent `signature: ""`.
- Rebuild must not emit thinking blocks until arm 1 or arm 2 is certified with a retained exhibit.
- Canonical LHC intake **does** capture empty-but-signed thinking and opaque signatures.

## Advancement criteria (future)

Arm 1 (`signed_verbatim`): native compact artifact + live reload where Claude keeps prior signatures without host invention.  
Arm 2 (`unsigned_visible`): independent current-binary exhibit that non-empty thinking without signature is a native safe shape on reload.
