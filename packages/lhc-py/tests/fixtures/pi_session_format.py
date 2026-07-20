"""Ported from packages/lhc/test/fixtures/pi-session-format.ts. Phase 1.

PI session format conformance (TC-5.3/TC-5.5): the required shapes are
DERIVED from the structure-trimmed real PI session fixture at runtime,
never restated from the design — the fixture's job is to catch the design
being wrong about PI, which a design-derived checker could not
(provenance: pi-session-structure.provenance.md). Checks are
structure-level: header line shape, entry shape, parentId chain, message
encoding.

Pure file I/O + validation — REAL in Phase 1.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_FIXTURE_PATH = Path(__file__).resolve().parent / "pi-session-structure.jsonl"


@dataclass(frozen=True, slots=True)
class ParsedSession:
    header: dict[str, Any]
    entries: list[dict[str, Any]]


def _parse_jsonl(text: str, label: str) -> ParsedSession:
    lines = [line for line in text.split("\n") if line != ""]
    if len(lines) == 0:
        raise ValueError(f"{label}: empty file")
    parsed: list[dict[str, Any]] = []
    for i, line in enumerate(lines):
        value: object = json.loads(line)
        if not isinstance(value, dict) or value is None or isinstance(value, list):
            raise ValueError(f"{label} line {i + 1}: not a JSON object")
        parsed.append(value)
    header, *entries = parsed
    return ParsedSession(header=header, entries=entries)


def load_pi_session_fixture() -> ParsedSession:
    return _parse_jsonl(_FIXTURE_PATH.read_text(encoding="utf-8"), "pi-session-structure fixture")


def _key_set(value: dict[str, Any]) -> str:
    return ",".join(sorted(value.keys()))


def _fail(where: str, expected: str, actual: object) -> None:
    raise ValueError(
        f"pi-session conformance violation at {where}: expected {expected}, got {json.dumps(actual, separators=(',', ':'))}"
    )


# Validates a materialized file's structure against the real-PI fixture:
#  - header: same key set as the fixture's header, same value types,
#    type === "session"
#  - every entry: type === "message" with exactly the key set the fixture's
#    message entries carry ({type, id, parentId, timestamp, message})
#  - parentId chain: first entry null, every later entry chained to the
#    previous entry's id; ids unique
#  - message encoding: role + content present; content an array of text
#    blocks shaped like the fixture's ({type: "text", text: string})
def assert_pi_session_conformance(materialized_text: str) -> None:
    fixture = load_pi_session_fixture()
    file = _parse_jsonl(materialized_text, "materialized session")

    # Header shape derived from the fixture header.
    if file.header.get("type") != "session":
        _fail("header.type", '"session"', file.header.get("type"))
    if _key_set(file.header) != _key_set(fixture.header):
        _fail("header keys", _key_set(fixture.header), _key_set(file.header))
    for key, fixture_value in fixture.header.items():
        if type(file.header.get(key)) is not type(fixture_value):
            _fail(f"header.{key} type", type(fixture_value).__name__, file.header.get(key))

    # Entry shape derived from the fixture's message entries.
    fixture_messages = [entry for entry in fixture.entries if entry.get("type") == "message"]
    if not fixture_messages:
        raise ValueError("pi-session-structure fixture carries no message entries")
    reference_entry = fixture_messages[0]
    reference_message = reference_entry["message"]
    if not isinstance(reference_message, dict):
        raise ValueError("pi-session-structure fixture message is not an object")
    reference_blocks = reference_message.get("content")
    if not isinstance(reference_blocks, list) or len(reference_blocks) == 0:
        raise ValueError("pi-session-structure fixture message has no content blocks")
    reference_text_block = next(
        (block for block in reference_blocks if isinstance(block, dict) and block.get("type") == "text"),
        None,
    )
    if reference_text_block is None:
        raise ValueError("pi-session-structure fixture message has no text block")

    seen_ids: set[str] = set()
    previous_id: str | None = None
    for i, entry in enumerate(file.entries):
        where = f"entry[{i}]"
        if entry.get("type") != "message":
            _fail(f"{where}.type", '"message"', entry.get("type"))
        if _key_set(entry) != _key_set(reference_entry):
            _fail(f"{where} keys", _key_set(reference_entry), _key_set(entry))
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or entry_id == "":
            _fail(f"{where}.id", "a non-empty string", entry_id)
        timestamp = entry.get("timestamp")
        if not isinstance(timestamp, str) or timestamp == "":
            _fail(f"{where}.timestamp", "a non-empty string", timestamp)
        if entry.get("parentId") != previous_id:
            _fail(
                f"{where}.parentId (chain)",
                json.dumps(previous_id, separators=(",", ":")),
                entry.get("parentId"),
            )
        if entry_id in seen_ids:
            _fail(f"{where}.id", "a unique id", entry_id)
        seen_ids.add(entry_id)
        previous_id = entry_id

        message = entry.get("message")
        if not isinstance(message, dict):
            _fail(f"{where}.message", "an object", message)
        role = message.get("role")
        if not isinstance(role, str) or role == "":
            _fail(f"{where}.message.role", "a non-empty string", role)
        content = message.get("content")
        if not isinstance(content, list) or len(content) == 0:
            _fail(f"{where}.message.content", "a non-empty block array", content)
        for j, block in enumerate(content):
            if not isinstance(block, dict):
                _fail(f"{where}.message.content[{j}]", "an object", block)
            if _key_set(block) != _key_set(reference_text_block):
                _fail(
                    f"{where}.message.content[{j}] keys",
                    _key_set(reference_text_block),
                    _key_set(block),
                )
            if block.get("type") != "text":
                _fail(f"{where}.message.content[{j}].type", '"text"', block.get("type"))
            if not isinstance(block.get("text"), str):
                _fail(f"{where}.message.content[{j}].text", "a string", block.get("text"))


__all__ = [
    "ParsedSession",
    "assert_pi_session_conformance",
    "load_pi_session_fixture",
]
