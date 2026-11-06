# Rollback

## Sub-features

- Record: `sdk.intakeStream.messageEvents(ref, [{ eventKind: "rollback", payload: { keepThroughEventOrder, reason? }, … }])` hides every live message recorded after the anchor, in the same batch. The anchor must sit below the rollback's own event order. `0` hides everything.
- Serve: `getLlmRequestContext`, `getSessionThreadView`, `messages.list`, `turns.listTurns`, retrieval, and `lhc thread export` all end at the anchor. `turns.listTurns` and the export drop fully hidden closed turns but still return the surviving open turn, which can be empty. A stored compact view whose compact point sits past the anchor is dropped, so serving falls back to the live tail until the next compact.
- Append: the next events grow the kept branch. Re-sending a hidden event's idempotency key is skipped as a duplicate and stays hidden; a redo needs fresh keys.
- Record honesty: `messages.list(ref, { includeDeleted: true })` returns hidden messages with `deleted: true`; `retrieval.getTurns` / `getMessages` answer `deleted` for hidden ids. `intakeStream.listEvents` keeps the `rollback` event itself.

## How to get to it (user POV)

A user rewinds a conversation in their host (T3 rollback, Claude rewind). The host maps its rewind point to an lhc event order, for example with `intakeStream.listEventKeysByPrefix` over its capture keys, and records one rollback event. From then on, the model never sees the discarded turns again, even after compaction, and the user's next message continues from the kept turn.

## Driving it with the harness

```sh
node .agents/skills/verify-lhc/helpers/rollback.mjs
```

Pass line: `verify-lhc rollback: PASS`. The drive seeds three turns, compacts so the second turn sits behind the compact point, rolls back to the end of turn 1, and checks both served views. It then appends a fourth turn, recompacts, serves again, and exports through the real CLI binary. The export must hold turn 1 then turn 4 and neither discarded turn. It prints the rollback settle time. `--keep` leaves the home in place.

Exit 3 with `verify-lhc rollback: UNSUPPORTED (this build has no rollback event)` means `messageEvents` refused the rollback batch. A build from before PR #25 refuses the event kind. An anchor at or past the rollback's own event order is refused the same way.

## Gotchas

- Rollback is hide-only. A second rollback can only hide more, and an anchor inside an already discarded stretch does not bring it back.
- The open turn stays open through a rollback, even when every member is hidden. The next prompt joins it.
- After a rollback behind the compact point, `threadView.describe` returns `null` until the next compact. That is the drop working, not a lost view.
- Exports of two independently seeded threads differ only in `.threadId`, `.exportedAt` and each `.turns[].messages[].recordedAt`, because seeded turn and message ids (`t1`, `m1`, ...) are deterministic. To compare two seeded exports, delete exactly those three fields, never every `recordedAt` key recursively, keep the raw exports beside the normalized ones, and show that a content change still differs. A real thread's ids are not deterministic, so this recipe does not apply to it.

  ```sh
  norm='del(.threadId, .exportedAt, .turns[].messages[].recordedAt)'
  jq -S "$norm" a.json > a.norm.json && jq -S "$norm" b.json > b.norm.json && diff a.norm.json b.norm.json
  jq '.turns[0].messages[0].blocks[0].content.text += " CHANGED"' b.json | jq -S "$norm" | diff -q a.norm.json - >/dev/null && echo "FAIL: a content change no longer differs"
  ```
