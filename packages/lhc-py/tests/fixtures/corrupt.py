"""Ported from packages/lhc/test/fixtures/corrupt.ts. Phase 1 skeleton.

NOT_JSON is pure data — real. The three writers below-SDK-write raw sqlite
rows (a second open turn / poisoned JSON columns), so they are skeletons.
"""

from __future__ import annotations

# The one sanctioned below-SDK write in the test suite: overwrites a message
# block's content, or a derived-form's metadata, with bytes strict JSON
# parsing rejects. Value must still *store* — see the TS module comment for
# the json_extract-accepts / JSON.parse-rejects needle this threads.
NOT_JSON = "{'unreadable': true,}"


def corrupt_two_open_turns(path: str) -> None:
    raise NotImplementedError


def poison_message_block_json(path: str, message_id: str) -> None:
    raise NotImplementedError


def poison_message_form_json(path: str, message_id: str) -> None:
    raise NotImplementedError


__all__ = [
    "NOT_JSON",
    "corrupt_two_open_turns",
    "poison_message_block_json",
    "poison_message_form_json",
]
