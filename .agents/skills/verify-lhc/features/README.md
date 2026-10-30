# verify-lhc feature map

Seeded features for core `lhc`. Each file covers one drivable feature.

- [thread-round-trip.md](thread-round-trip.md) — create, append, compact, serve one thread.
- [retrieval.md](retrieval.md) — drill back into stored turns and messages by id.
- [rollback.md](rollback.md) — a host rewinds the thread and lhc serves the kept branch only.
- [compact-policy.md](compact-policy.md) — a host stores its compact pair on the thread, and copies and migrations keep it.
- [cli-thread-ops.md](cli-thread-ops.md) — the `lhc thread` CLI verbs against a home.

Back to the skill: [../SKILL.md](../SKILL.md).
