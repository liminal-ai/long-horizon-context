"""Ported from packages/lhc/test/fixtures/view-thread.ts. Phase 1 skeleton.

The Epic 03 derived-thread fixture (Story 0, FC-0.3/0.4/0.5): one recorded
conversation — 12 turns, 4 chunks, tool-heavy middle — drained through the
real Epic 02 machinery. Types/constants are REAL; SDK-calling builders are
skeletons.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from lhc.intake_stream import MessageEventInput
from lhc.messages import EditInput, MutationResult
from lhc.sdk import Lhc, init_lhc
from lhc.shared_tech.derivation import ChunkPolicyConfig, DerivationReportEntry
from lhc.shared_tech.storage import open_database
from lhc.shared_tech.view import CompactReceipt
from lhc.thread_view import CompactOpts

from .corrupt import corrupt_two_open_turns
from .inference_callbacks_double import InferenceCallbacksDouble, create_inference_callbacks_double
from .threads import ChunkSnapshot, read_chunks

if TYPE_CHECKING:
    from . import TempStore

# Reason classes the scripted failures stamp, chosen from the sweep
# classification table's vocabulary (tech design §Spec Validation): a
# rate-limit class reads transient, a content-refusal class reads permanent —
# FC-0.4's distinguishable-on-read-back guarantee, proven here before
# Story 3 depends on it.
RATE_LIMIT_FAILURE_REASON = "rate_limit: scripted failure (fixture)"
PERMANENT_FAILURE_REASON = "content_refusal: scripted permanent failure (fixture)"

# Chunk policy pinned so the 12 fixed-shape turns cut into exactly 4 chunks
# (3 members each; c1–c3 closed, c4 still open). Projections from the
# deterministic double are near-constant in size (`projection(<digest>:<40
# chars>)`), so the cut is stable; the builder asserts the shape and throws
# if drift ever moves it.
_FIXTURE_CHUNK_POLICY = ChunkPolicyConfig(
    target_projected_tokens=90,
    max_projected_tokens=4400,
)

_TURN_COUNT = 12
_TOOL_HEAVY_TURNS = frozenset({5, 6, 7, 8})


def _turn_events(turn: int) -> list[MessageEventInput]:
    from . import valid_event

    events: list[MessageEventInput] = [
        valid_event(
            "user_prompt",
            {"payload": {"text": f"turn {turn}: please investigate area {turn}"}},
        ),
        valid_event(
            "assistant_thinking",
            {"payload": {"text": f"considering what area {turn} contains"}},
        ),
    ]
    if turn in _TOOL_HEAVY_TURNS:
        # The tool-heavy middle: two tool runs per turn — what gives Story 4 a
        # realistic over-max zone of tool results to age behind the boundary.
        for run in (1, 2):
            tool_call_id = f"call-fx-{turn}-{run}"
            events.extend(
                [
                    valid_event(
                        "tool_call",
                        {
                            "payload": {
                                "toolCallId": tool_call_id,
                                "toolName": "read_file",
                                "arguments": {"path": f"area-{turn}/file-{run}.txt"},
                            },
                        },
                    ),
                    valid_event(
                        "tool_result",
                        {
                            "payload": {
                                "toolCallId": tool_call_id,
                                "content": (
                                    f"contents of area-{turn}/file-{run}.txt: "
                                    f"detail {turn}.{run} with enough text to summarize"
                                ),
                                "isError": False,
                            },
                        },
                    ),
                ]
            )
    events.extend(
        [
            valid_event(
                "assistant_text",
                {"payload": {"text": f"findings for area {turn}"}},
            ),
            valid_event("turn_end"),
        ]
    )
    return events


async def _send(
    sdk: Lhc,
    file_path: str,
    batch: Sequence[MessageEventInput],
) -> list[str]:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, list(batch))
    if not result.ok:
        raise RuntimeError(f"fixture batch failed: {result.error.reason}")
    return [
        ("" if entry.message_id is None else str(entry.message_id))
        for entry in result.value.events
    ]


async def _drain(sdk: Lhc, file_path: str) -> None:
    report = await sdk.work.drain({"filePath": file_path})
    if not report.ok:
        raise RuntimeError(f"fixture drain failed: {report.error.reason}")
    if report.value.stopped_because != "empty" or report.value.remaining != 0:
        raise RuntimeError(
            "fixture drain left work behind "
            f"(stopped: {report.value.stopped_because}, remaining: {report.value.remaining})"
        )


def _failed_entries(
    entries: Sequence[DerivationReportEntry],
    reason: str,
) -> list[DerivationReportEntry]:
    return [entry for entry in entries if entry.state == "failed" and entry.reason == reason]


def _set_message_derivation_failed(file_path: str, subject_id: str, reason: str) -> None:
    db = open_database(file_path)
    try:
        db.prepare(
            """UPDATE derivation
       SET state = 'failed', content = NULL, reason = ?, metadata = NULL, derived_at = ?
       WHERE subject_kind = 'message' AND subject_id = ?
         AND derivation_type = 'tool_result_summary'"""
        ).run(reason, "2026-01-01T00:00:00.000Z", subject_id)
    finally:
        db.close()


@dataclass(frozen=True, slots=True)
class DerivedThreadFixture:
    file_path: str
    sdk: Lhc
    double: InferenceCallbacksDouble
    turn_ids: list[str]  # t1..t12
    chunks: ChunkSnapshot
    # The two manufactured failed subjects (tool_result_summary forms), reached
    # through real terminal failure — absent when failures
    # are disabled for a variant.
    failed_transient_message_id: str | None = None
    failed_permanent_message_id: str | None = None


@dataclass(frozen=True, slots=True)
class DerivedThreadOptions:
    failures: bool = True  # default true: manufacture the two failed states


@dataclass(frozen=True, slots=True)
class MutationInFlightFixture:
    file_path: str
    sdk: Lhc
    double: InferenceCallbacksDouble
    turn_ids: list[str]
    chunks: ChunkSnapshot
    compact_receipt: CompactReceipt
    edited_message_id: str
    # The cascade contract's exact account of the edit: cleared set, queued
    # replacements, superseded items — what the bracketing health reads
    # assert against.
    mutation: MutationResult
    failed_transient_message_id: str | None = None
    failed_permanent_message_id: str | None = None


@dataclass(frozen=True, slots=True)
class MixedStateFixture:
    file_path: str
    sdk: Lhc
    double: InferenceCallbacksDouble
    turn_ids: list[str]
    chunks: ChunkSnapshot
    blocked_turn_id: str  # t13: turn forms blocked through the terminal path
    pending_prompt_message_id: str  # t14's prompt: smoothed_prompt still queued
    failed_transient_message_id: str | None = None
    failed_permanent_message_id: str | None = None


# TS returns anonymous `{ filePath; sdk }` / `{ filePath; sdk; blockedTurnId }`.
@dataclass(frozen=True, slots=True)
class _CorruptedVariantResult:
    file_path: str
    sdk: Lhc


@dataclass(frozen=True, slots=True)
class _BlockedSiblingResult:
    file_path: str
    sdk: Lhc
    blocked_turn_id: str


async def derived_thread_fixture(
    store: TempStore,
    opts: DerivedThreadOptions | None = None,
) -> DerivedThreadFixture:
    options = DerivedThreadOptions() if opts is None else opts
    failures = options.failures

    double = create_inference_callbacks_double()
    sdk = init_lhc(
        {
            "inferenceCallbacks": double,
            "mode": "manual",
            "guards": {"detailedTurnCompression": {"tinyTurnTokens": 1}},
            "chunkPolicy": {
                "targetProjectedTokens": _FIXTURE_CHUNK_POLICY.target_projected_tokens,
                "maxProjectedTokens": _FIXTURE_CHUNK_POLICY.max_projected_tokens,
            },
            "toolResult": {
                "smallTierTokens": 1,
                "smallTargetRatio": 0.15,
                "midTargetRatio": 0.04,
            },
        }
    )

    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")

    turn_ids: list[str] = []
    failed_transient: str | None = None
    failed_permanent: str | None = None

    for turn in range(1, _TURN_COUNT + 1):
        if failures and turn == 6:
            # The first tool_result_summary item of this batch lands failed with the
            # rate-limit reason class.
            double.fail_kind(
                "tool_result_summary",
                1,
                {"reason": RATE_LIMIT_FAILURE_REASON},
            )
        if failures and turn == 7:
            # The first tool_result_summary item lands with the permanent reason class.
            double.fail_kind(
                "tool_result_summary",
                1,
                {"reason": PERMANENT_FAILURE_REASON},
            )
        message_ids = await _send(sdk, file_path, _turn_events(turn))
        # Batch shape is fixed for tool-heavy turns: prompt, thinking, call,
        # result, call, result, text, end — index 3 is the first tool result,
        # the scripted failures' subject.
        first_tool_result_id = message_ids[3] if len(message_ids) > 3 else None
        if failures and turn in (6, 7):
            if first_tool_result_id is None or first_tool_result_id == "":
                raise RuntimeError(
                    f"fixture invariant: turn {turn} carries no first tool result message"
                )
            if turn == 6:
                failed_transient = first_tool_result_id
            else:
                failed_permanent = first_tool_result_id
        await _drain(sdk, file_path)
        turn_ids.append(f"t{turn}")

    chunks = read_chunks(file_path)
    if len(chunks["chunks"]) != 4:
        raise RuntimeError(
            f"fixture invariant: expected 4 chunks, got {len(chunks['chunks'])} "
            "— re-pin FIXTURE_CHUNK_POLICY"
        )
    closed = sum(1 for chunk in chunks["chunks"] if chunk["status"] == "closed")
    if closed != 3:
        raise RuntimeError(
            f"fixture invariant: expected 3 closed chunks, got {closed} closed "
            "— re-pin FIXTURE_CHUNK_POLICY"
        )

    if failures:
        if failed_transient is not None:
            _set_message_derivation_failed(
                file_path, failed_transient, RATE_LIMIT_FAILURE_REASON
            )
        if failed_permanent is not None:
            _set_message_derivation_failed(
                file_path, failed_permanent, PERMANENT_FAILURE_REASON
            )
        report = await sdk.messages.report({"filePath": file_path})
        if not report.ok:
            raise RuntimeError(f"fixture report failed: {report.error.reason}")
        transient = _failed_entries(report.value, RATE_LIMIT_FAILURE_REASON)
        permanent = _failed_entries(report.value, PERMANENT_FAILURE_REASON)
        if (
            len(transient) != 1
            or transient[0].subject_id != failed_transient
            or len(permanent) != 1
            or permanent[0].subject_id != failed_permanent
        ):
            raise RuntimeError(
                "fixture invariant: expected exactly one transient-failed and one "
                "permanent-failed tool_result_summary on the named subjects"
            )

    return DerivedThreadFixture(
        file_path=file_path,
        sdk=sdk,
        double=double,
        turn_ids=turn_ids,
        chunks=chunks,
        failed_transient_message_id=failed_transient,
        failed_permanent_message_id=failed_permanent,
    )


# The canonical-corruption variant (FC-0.5, Epic 01 fixture pattern): a
# short real conversation, drained clean, then damaged below the SDK into
# the two-open-turns state no public operation can produce. Canonical
# consumers refuse it with state_corruption.
async def corrupted_variant_thread(store: TempStore) -> _CorruptedVariantResult:
    from . import valid_event

    double = create_inference_callbacks_double()
    sdk = init_lhc(
        {
            "inferenceCallbacks": double,
            "mode": "manual",
            "guards": {"detailedTurnCompression": {"tinyTurnTokens": 1}},
        }
    )
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    for turn in range(1, 4):
        await _send(sdk, file_path, _turn_events(turn))
    await _drain(sdk, file_path)
    # Open a turn through real intake, then add a second open row: two open
    # turns, the Epic 01 invariant violation.
    await _send(
        sdk,
        file_path,
        [valid_event("user_prompt", {"payload": {"text": "left open before the damage"}})],
    )
    corrupt_two_open_turns(file_path)
    return _CorruptedVariantResult(file_path=file_path, sdk=sdk)


# ── Epic 04 Story 2 extensions (test plan: fixture extended in place) ──


async def mutation_in_flight_variant(store: TempStore) -> MutationInFlightFixture:
    # No manufactured failures: the bracket's "nothing outside the cascade
    # changed state" assertion wants a clean baseline.
    fixture = await derived_thread_fixture(store, DerivedThreadOptions(failures=False))
    sdk = fixture.sdk
    file_path = fixture.file_path

    compacted = await sdk.thread_view.compact({"filePath": file_path}, CompactOpts())
    if not compacted.ok:
        raise RuntimeError(f"fixture compact failed: {compacted.error.reason}")

    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError(f"fixture list failed: {listed.error.reason}")
    target = next(
        (
            record
            for record in listed.value
            if record.kind == "user_prompt" and record.turn_id == "t2"
        ),
        None,
    )
    if target is None:
        raise RuntimeError("fixture invariant: turn 2 carries no prompt message")

    edited = await sdk.messages.edit(
        {"filePath": file_path},
        EditInput(
            message_id=target.message_id,
            content="turn 2 revised: investigate area 2 again",
        ),
    )
    if not edited.ok:
        raise RuntimeError(f"fixture edit failed: {edited.error.reason}")

    return MutationInFlightFixture(
        file_path=fixture.file_path,
        sdk=fixture.sdk,
        double=fixture.double,
        turn_ids=fixture.turn_ids,
        chunks=fixture.chunks,
        compact_receipt=compacted.value,
        edited_message_id=target.message_id,
        mutation=edited.value,
        failed_transient_message_id=fixture.failed_transient_message_id,
        failed_permanent_message_id=fixture.failed_permanent_message_id,
    )


async def mixed_state_variant_thread(store: TempStore) -> MixedStateFixture:
    from . import valid_event

    fixture = await derived_thread_fixture(store)
    sdk = fixture.sdk
    file_path = fixture.file_path

    # Turn 13 closes cleanly but is NOT drained: its prompt smoothing and turn
    # derivation sit queued (events: prompt, thinking, text, end — no tools).
    await _send(sdk, file_path, _turn_events(13))

    # Turn 14 opens with a lone prompt: one more queued smoothing item that the
    # partial drain below will leave pending.
    prompt_ids = await _send(
        sdk,
        file_path,
        [
            valid_event(
                "user_prompt",
                {"payload": {"text": "turn 14: this prompt's smoothing stays pending"}},
            )
        ],
    )
    pending_prompt_message_id = prompt_ids[0] if prompt_ids else None
    if pending_prompt_message_id is None or pending_prompt_message_id == "":
        raise RuntimeError("fixture invariant: turn 14 prompt did not project")

    # Real source damage: t14 is open, the corruption writer adds a second open
    # row — the state t13's claimed derivation meets at drain time.
    corrupt_two_open_turns(file_path)

    # Partial drain, head-first FIFO: item 1 is t13's prompt smoothing (ready),
    # item 2 is t13's turn derivation (terminal on the damage → blocked).
    # t14's smoothing stays queued — the live pending state.
    report = await sdk.work.drain({"filePath": file_path}, {"maxItems": 2})
    if not report.ok:
        raise RuntimeError(f"fixture drain failed: {report.error.reason}")
    blocked_run = next(
        (
            entry
            for entry in report.value.ran
            if entry.kind == "turn_derivation"
            and entry.disposition == "failed_terminal"
        ),
        None,
    )
    if blocked_run is None:
        raise RuntimeError(
            "fixture invariant: turn 13 derivation expected to land terminal on damage"
        )
    if report.value.remaining != 1:
        raise RuntimeError(
            "fixture invariant: expected exactly one queued item left, "
            f"got {report.value.remaining}"
        )

    return MixedStateFixture(
        file_path=fixture.file_path,
        sdk=fixture.sdk,
        double=fixture.double,
        turn_ids=fixture.turn_ids,
        chunks=fixture.chunks,
        blocked_turn_id="t13",
        pending_prompt_message_id=pending_prompt_message_id,
        failed_transient_message_id=fixture.failed_transient_message_id,
        failed_permanent_message_id=fixture.failed_permanent_message_id,
    )


# The blocked state's sacrificial sibling (FC-0.3): a closed turn whose
# queued derivation meets real source damage at drain time — the handler
# finds two open turns and lands the turn forms blocked through the
# production terminal path, never a hand-written row.
async def blocked_sibling_thread(store: TempStore) -> _BlockedSiblingResult:
    from . import valid_event

    double = create_inference_callbacks_double()
    sdk = init_lhc(
        {
            "inferenceCallbacks": double,
            "mode": "manual",
            "guards": {"detailedTurnCompression": {"tinyTurnTokens": 1}},
        }
    )
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    # Turn 1 closes (its turn_derivation queues); a second turn opens through
    # real intake; the corruption writer adds another open row. The drain then
    # claims t1's derivation against a record with two open turns.
    await _send(sdk, file_path, _turn_events(1))
    await _send(
        sdk,
        file_path,
        [valid_event("user_prompt", {"payload": {"text": "left open before the damage"}})],
    )
    corrupt_two_open_turns(file_path)
    report = await sdk.work.drain({"filePath": file_path})
    if not report.ok:
        raise RuntimeError(f"fixture drain failed: {report.error.reason}")
    blocked = next(
        (
            entry
            for entry in report.value.ran
            if entry.kind == "turn_derivation"
            and entry.disposition == "failed_terminal"
        ),
        None,
    )
    if blocked is None:
        raise RuntimeError(
            "fixture invariant: turn_derivation expected to land terminal on damage"
        )
    return _BlockedSiblingResult(file_path=file_path, sdk=sdk, blocked_turn_id="t1")


__all__ = [
    "PERMANENT_FAILURE_REASON",
    "RATE_LIMIT_FAILURE_REASON",
    "DerivedThreadFixture",
    "DerivedThreadOptions",
    "MixedStateFixture",
    "MutationInFlightFixture",
    "blocked_sibling_thread",
    "corrupted_variant_thread",
    "derived_thread_fixture",
    "mixed_state_variant_thread",
    "mutation_in_flight_variant",
]
