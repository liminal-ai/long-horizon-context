"""Ported from packages/lhc/test/fixtures/view-boundary.ts. Phase 1.

Scripted turns for visibility-boundary intake and rendering tests.
Data-construction helpers are REAL; seed_turned_tool_results is skeletal
(SDK-calling).
"""

from __future__ import annotations

from dataclasses import dataclass

from lhc.intake_stream import MessageEventInput
from lhc.sdk import Lhc

# "tok" tokenizes to exactly one o200k token, joined or leading-space alike,
# so a content of n joined "tok" words carries token_estimate n — the same
# hand-derivable unit the boundary goldens use.


def boundary_tokens(n: int) -> str:
    return " ".join(["tok"] * n)


_boundary_call_counter = 0


# One tool run: call + result with the given token count. If sent while a
# turn is open, current intake stamps it with that turn.
def boundary_tool_run(result_tokens: int) -> list[MessageEventInput]:
    from . import valid_event

    global _boundary_call_counter
    _boundary_call_counter += 1
    tool_call_id = f"call-tb-{_boundary_call_counter}"
    return [
        valid_event(
            "tool_call",
            {
                "payload": {
                    "toolCallId": tool_call_id,
                    "toolName": "read_file",
                    "arguments": {"path": f"tb-{_boundary_call_counter}.txt"},
                },
            },
        ),
        valid_event(
            "tool_result",
            {
                "payload": {
                    "toolCallId": tool_call_id,
                    "content": boundary_tokens(result_tokens),
                    "isError": False,
                },
            },
        ),
    ]


# One scripted turn's worth of tool results, sized in tokens. `close: false`
# leaves the turn open (mid-turn legs).
@dataclass(frozen=True, slots=True)
class TurnedToolResultsSpec:
    results: tuple[int, ...]
    close: bool = True


def turned_tool_result_events(turns: list[TurnedToolResultsSpec]) -> list[MessageEventInput]:
    from . import valid_event

    events: list[MessageEventInput] = []
    for turn in turns:
        events.append(valid_event("user_prompt", {"payload": {"text": "scripted boundary turn"}}))
        for n in turn.results:
            events.extend(boundary_tool_run(n))
        if turn.close is not False:
            events.append(valid_event("turn_end"))
    return events


# Seed scripted turns through intake.
async def seed_turned_tool_results(
    sdk: Lhc,
    file_path: str,
    turns: list[TurnedToolResultsSpec],
) -> None:
    raise NotImplementedError


__all__ = [
    "TurnedToolResultsSpec",
    "boundary_tokens",
    "boundary_tool_run",
    "seed_turned_tool_results",
    "turned_tool_result_events",
]
