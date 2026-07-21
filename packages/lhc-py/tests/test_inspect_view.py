"""Ported from packages/lhc/test/inspect-view.test.ts. Phase 1.

Story 3 (Epic 04), default suite: TC-2.1–2.3 — the view-contents report
plus the describe legs. `threadView.describe` exposes the stored active
view row verbatim (null when absent, never recomputed); `inspect.view`
composes describe + a measured context read so loadCost equals what model context serves
now (AC-2.3, parity by construction) — asserted here against an
INDEPENDENT context read re-measured with the same estimator, on a compacted
and a never-compacted thread (meta null, tail-only, AC-2.4). Reads are
pure (AC-1.4 contract): read-only delta assert, zero model calls.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any, Protocol, TypeVar

import pytest

from lhc import Lhc, MessageEventInput, init_lhc
from lhc.messages import EditInput
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.inspect import (
    ViewContentsBand,
    ViewContentsBandEntry,
    ViewContentsGap,
    ViewContentsMeta,
    ViewContentsMetaConfig,
    ViewContentsReport,
)
from lhc.shared_tech.token_counting import estimate_tokens
from lhc.shared_tech.view import (
    LlmRequestContext,
    LlmRequestContextMessage,
    PartialViewProfilePercentages,
    PartialVisibilityBudgets,
    SdkViewConfig,
    StoredView,
    StoredViewArrangementEntry,
    StoredViewBand,
    StoredViewConfig,
    StoredViewGap,
    StoredViewSourceState,
    ViewCompactParams,
)
from lhc.thread_view import CompactOpts
from lhc.threads import NewThreadInput
from fixtures import (
    DerivedThreadFixture,
    TempStore,
    create_inference_callbacks_double,
    derived_thread_fixture,
    expect_read_only,
    open_raw,
    seed_view_boundary,
    temp_store,
    valid_event,
)
from fixtures.view_thread import DerivedThreadOptions


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


def _to_jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


_T = TypeVar("_T")


class _ServedTextPart(Protocol):
    text: str


class _ServedTextMessage(Protocol):
    content: str | list[_ServedTextPart] | tuple[_ServedTextPart, ...]


def _result_value(result: OpResult[_T]) -> _T:
    if not result.ok:
        raise RuntimeError(
            f"expected ok result: {json.dumps(_to_jsonable(result), separators=(',', ':'))}"
        )
    return result.value  # type: ignore[return-value]


def _served_text(message: _ServedTextMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    return "".join(part.text for part in content)


def _is_band_message(message: _ServedTextMessage) -> bool:
    return _served_text(message).startswith("[context ·")


def _measured(messages: list[_ServedTextMessage]) -> int:
    return sum(estimate_tokens(_served_text(message)) for message in messages)


def _read_raw_stored_view(file_path: str) -> StoredView | None:
    """Independent stored-row read (anti-shim). SQL verbatim from TS."""
    db = open_raw(file_path)
    try:
        header = db.prepare(
            """SELECT view_id, created_at, compact_point, covered_from, profile_name,
                config_json, arrangement_json, gaps_json, source_state_json
         FROM thread_view WHERE singleton = 1"""
        ).get()
        if header is None:
            return None
        band_rows = db.prepare(
            "SELECT band, token_count FROM thread_view_band WHERE view_id = ?"
        ).all(header["view_id"])  # type: ignore[index]
        by_band = {str(row["band"]): row for row in band_rows}

        config_raw = json.loads(str(header["config_json"]))  # type: ignore[index]
        arrangement_raw = json.loads(str(header["arrangement_json"]))  # type: ignore[index]
        gaps_raw = json.loads(str(header["gaps_json"]))  # type: ignore[index]
        source_raw = json.loads(str(header["source_state_json"]))  # type: ignore[index]

        # DB JSON is camelCase (TS wire); map into Python snake_case dataclasses.
        config = StoredViewConfig(
            lower_bound=config_raw["lowerBound"],
            percentages=dict(config_raw["percentages"]),
        )
        arrangement = [
            StoredViewArrangementEntry(
                band=entry["band"],
                subject_kind=entry["subjectKind"],
                subject_id=entry["subjectId"],
                derivation_used=entry["derivationUsed"],
                degraded=bool(entry["degraded"]),
            )
            for entry in arrangement_raw
        ]
        gaps = [
            StoredViewGap(
                band=entry["band"],
                subject_id=entry["subjectId"],
                reason=entry["reason"],
            )
            for entry in gaps_raw
        ]
        source_state = StoredViewSourceState(
            max_event_order=source_raw["maxEventOrder"],
            derivation_counts=dict(source_raw["derivationCounts"]),
        )
        bands: list[StoredViewBand] = []
        for band in ("brief", "detailed", "smooth"):
            row = by_band.get(band)
            if row is not None:
                bands.append(
                    StoredViewBand(band=band, stored_tokens=int(row["token_count"]))  # type: ignore[arg-type]
                )
        return StoredView(
            view_id=str(header["view_id"]),  # type: ignore[index]
            created_at=str(header["created_at"]),  # type: ignore[index]
            compact_point=int(header["compact_point"]),  # type: ignore[index]
            covered_from=int(header["covered_from"]),  # type: ignore[index]
            profile_name=(
                None
                if header["profile_name"] is None  # type: ignore[index]
                else str(header["profile_name"])  # type: ignore[index]
            ),
            config=config,
            arrangement=arrangement,
            gaps=gaps,
            source_state=source_state,
            bands=bands,
        )
    finally:
        db.close()


def _bands_from_raw(raw: StoredView) -> list[ViewContentsBand]:
    result: list[ViewContentsBand] = []
    for band in ("brief", "detailed", "smooth"):
        entries = [
            ViewContentsBandEntry(
                subject_kind=entry.subject_kind,
                subject_id=entry.subject_id,
                derivation_used=entry.derivation_used,
                degraded=entry.degraded,
            )
            for entry in raw.arrangement
            if entry.band == band
        ]
        stored = next((row for row in raw.bands if row.band == band), None)
        if len(entries) == 0 and stored is None:
            continue
        result.append(
            ViewContentsBand(
                band=band,  # type: ignore[arg-type]
                entries=entries,
                stored_tokens=stored.stored_tokens if stored is not None else 0,
            )
        )
    return result


_DEGRADED_COMPACT_PARAMS = ViewCompactParams(
    lower_bound=400,
    percentages=PartialViewProfilePercentages(full=25, smooth=25, detailed=10, brief=40),
)


async def _degraded_compacted_thread(store: TempStore) -> DerivedThreadFixture:
    fixture = await derived_thread_fixture(store, DerivedThreadOptions(failures=False))
    sdk = fixture.sdk
    file_path = fixture.file_path
    listed = await sdk.messages.list({"filePath": file_path})
    if not listed.ok:
        raise RuntimeError(f"fixture list failed: {listed.error.reason}")
    for turn in ("t4", "t5", "t6", "t8"):
        target = next(
            (
                record
                for record in listed.value
                if record.kind == "user_prompt" and record.turn_id == turn
            ),
            None,
        )
        if target is None:
            raise RuntimeError(f"fixture invariant: no prompt in {turn}")
        edited = await sdk.messages.edit(
            {"filePath": file_path},
            EditInput(
                message_id=target.message_id,
                content=f"{turn} revised: investigate the area again",
            ),
        )
        if not edited.ok:
            raise RuntimeError(f"fixture edit failed: {edited.error.reason}")
    compacted = await sdk.thread_view.compact(
        {"filePath": file_path}, CompactOpts(params=_DEGRADED_COMPACT_PARAMS)
    )
    if not compacted.ok:
        raise RuntimeError(f"fixture compact failed: {compacted.error.reason}")
    return fixture


@dataclass(frozen=True, slots=True)
class _NeverCompactedThread:
    file_path: str
    sdk: Lhc


async def _never_compacted_thread(store: TempStore) -> _NeverCompactedThread:
    double = create_inference_callbacks_double()
    sdk = init_lhc(SdkConfig(inference_callbacks=double, mode="manual"))
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"fixture thread creation failed: {created.error.reason}")
    batches: list[list[MessageEventInput]] = [
        [
            valid_event("user_prompt", {"payload": {"text": "please read notes.txt"}}),
            valid_event("assistant_text", {"payload": {"text": "reading it now"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-iv-1",
                        "toolName": "read_file",
                        "arguments": {"path": "notes.txt"},
                    },
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-iv-1",
                        "content": "contents of notes.txt",
                        "isError": False,
                    },
                },
            ),
            valid_event("turn_end"),
        ],
        [
            valid_event("user_prompt", {"payload": {"text": "summarize what you read"}}),
            valid_event("assistant_text", {"payload": {"text": "here is the summary"}}),
            valid_event("turn_end"),
        ],
    ]
    for batch in batches:
        sent = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
        if not sent.ok:
            raise RuntimeError(f"fixture batch failed: {sent.error.reason}")
    drained = await sdk.work.drain({"filePath": file_path})
    if not drained.ok:
        raise RuntimeError(f"fixture drain failed: {drained.error.reason}")
    return _NeverCompactedThread(file_path=file_path, sdk=sdk)


def _tokens(n: int) -> str:
    return " ".join(["tok"] * n)


async def test_report_entries_derivations_degraded_flags_gap_reasons_config_and_provenance_equal_describe_output_and_the_stored_row(
    store: TempStore,
) -> None:
    """report entries, derivations, degraded flags, gap reasons, config, and provenance equal describe output and the stored row"""
    fixture = await _degraded_compacted_thread(store)
    file_path = fixture.file_path
    sdk = fixture.sdk
    raw = _read_raw_stored_view(file_path)
    assert raw is not None
    if raw is None:
        return

    described = _result_value(await sdk.thread_view.describe({"filePath": file_path}))
    assert described == raw

    report: ViewContentsReport = _result_value(await sdk.inspect.view({"filePath": file_path}))
    assert report.meta == ViewContentsMeta(
        view_id=raw.view_id,
        created_at=raw.created_at,
        profile=None,
        config=ViewContentsMetaConfig(
            lower_bound=400,
            percentages={"full": 25, "smooth": 25, "detailed": 10, "brief": 40},
        ),
        compact_point=raw.compact_point,
        covered_from=raw.covered_from,
    )
    assert report.meta is not None
    assert report.meta.config == ViewContentsMetaConfig(
        lower_bound=raw.config.lower_bound,
        percentages=raw.config.percentages,
    )

    assert report.bands == _bands_from_raw(raw)
    assert report.gaps == [
        ViewContentsGap(band=g.band, subject_id=g.subject_id, reason=g.reason) for g in raw.gaps
    ]
    if report.source_state is None:
        assert False, "expected source_state on compacted report"
    assert report.source_state.max_event_order == raw.source_state.max_event_order
    assert report.source_state.derivation_counts == raw.source_state.derivation_counts

    entries = [entry for band in report.bands for entry in band.entries]
    assert any(entry.subject_id == "t8" and entry.degraded for entry in entries)
    assert len(report.gaps) == 0
    assert any(entry.subject_id == "c2" and entry.degraded for entry in entries)

    context_read: LlmRequestContext = _result_value(
        await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    )
    assert report.load_cost.total == _measured(context_read.messages)
    assert report.load_cost.band_tokens == _measured(
        [m for m in context_read.messages if _is_band_message(m)]
    )
    assert report.load_cost.total == report.load_cost.band_tokens + report.load_cost.tail_tokens
    assert report.tail.message_count == len(
        [m for m in context_read.messages if not _is_band_message(m)]
    )


async def test_describe_returns_ok_null_on_a_never_compacted_thread_and_thread_not_found_on_a_missing_one(
    store: TempStore,
) -> None:
    """describe returns ok/null on a never-compacted thread and thread_not_found on a missing one"""
    never = await _never_compacted_thread(store)
    file_path, sdk = never.file_path, never.sdk
    described = await sdk.thread_view.describe({"filePath": file_path})
    assert described.ok is True
    if described.ok:
        assert described.value is None
    assert _read_raw_stored_view(file_path) is None

    missing = await sdk.thread_view.describe({"filePath": store.thread_path("missing")})
    assert missing.ok is False
    if not missing.ok:
        assert missing.error.error_class == "caller_error"
        assert missing.error.code == "thread_not_found"


async def test_tail_costs_short_forms_short_and_total_equals_an_independent_context_read_re_measured(
    store: TempStore,
) -> None:
    """tail costs short forms short and total equals an independent context read re-measured"""
    sdk = init_lhc(
        SdkConfig(
            inference_callbacks=create_inference_callbacks_double(),
            mode="manual",
            view=SdkViewConfig(
                visibility=PartialVisibilityBudgets(max_tokens=100, target_tokens=60)
            ),
        )
    )
    file_path = store.thread_path()
    created = await sdk.threads.new_thread(
        NewThreadInput(file_path=file_path, registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(f"thread creation failed: {created.error.reason}")

    for turn in range(1, 7):
        sent = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            [
                valid_event(
                    "user_prompt",
                    {"payload": {"text": f"turn {turn}: please investigate area {turn}"}},
                ),
                valid_event(
                    "assistant_text",
                    {"payload": {"text": f"findings for area {turn}"}},
                ),
                valid_event("turn_end"),
            ],
        )
        if not sent.ok:
            raise RuntimeError(f"intake failed: {sent.error.reason}")
        drained = await sdk.work.drain({"filePath": file_path})
        if not drained.ok:
            raise RuntimeError(f"drain failed: {drained.error.reason}")

    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(
            params=ViewCompactParams(
                lower_bound=60,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=25, detailed=10, brief=40
                ),
            )
        ),
    )
    assert compacted.ok is True
    if not compacted.ok:
        return

    for run in (1, 2):
        sent = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            [
                valid_event(
                    "user_prompt",
                    {"payload": {"text": f"post-compact tool run {run}"}},
                ),
                valid_event(
                    "tool_call",
                    {
                        "payload": {
                            "toolCallId": f"call-adv-{run}",
                            "toolName": "read_file",
                            "arguments": {"path": f"adv-{run}.txt"},
                        },
                    },
                ),
                valid_event(
                    "tool_result",
                    {
                        "payload": {
                            "toolCallId": f"call-adv-{run}",
                            "content": _tokens(150),
                            "isError": False,
                        },
                    },
                ),
                valid_event("turn_end"),
            ],
        )
        if not sent.ok:
            raise RuntimeError(f"intake failed: {sent.error.reason}")

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    tail_results = sorted(
        [
            message
            for message in listed.value
            if message.kind == "tool_result"
            and message.source_event_order > compacted.value.compact_point
        ],
        key=lambda m: m.source_event_order,
    )
    assert len(tail_results) == 2
    seed_view_boundary(file_path, tail_results[0].source_event_order)

    context_read: LlmRequestContext = _result_value(
        await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    )
    db = open_raw(file_path)
    try:
        row = db.prepare("SELECT position FROM view_boundary").get()
        assert row is not None
        boundary_position = int(row["position"])  # type: ignore[index]
    finally:
        db.close()
    assert boundary_position > compacted.value.compact_point
    tail_served = [m for m in context_read.messages if not _is_band_message(m)]
    abridged = [m for m in tail_served if " · abridged]" in _served_text(m)]
    full_results = [
        m
        for m in tail_served
        if _served_text(m).startswith("[tool result · ")
        and " · abridged]" not in _served_text(m)
    ]
    assert len(abridged) == 1
    assert len(full_results) == 1
    assert estimate_tokens(_served_text(abridged[0])) < estimate_tokens(
        _served_text(full_results[0])
    )

    report: ViewContentsReport = _result_value(await sdk.inspect.view({"filePath": file_path}))
    assert report.tail.message_count == len(tail_served)
    assert report.tail.tokens == _measured(tail_served)
    assert report.load_cost.tail_tokens == report.tail.tokens
    assert report.load_cost.total == _measured(context_read.messages)
    assert report.load_cost.total == report.load_cost.band_tokens + report.load_cost.tail_tokens


async def test_meta_null_bands_empty_tail_spans_the_record_cost_parity_holds(
    store: TempStore,
) -> None:
    """meta null, bands empty, tail spans the record, cost parity holds"""
    never = await _never_compacted_thread(store)
    file_path, sdk = never.file_path, never.sdk
    report: ViewContentsReport = _result_value(await sdk.inspect.view({"filePath": file_path}))
    assert report.meta is None
    assert report.bands == []
    assert report.gaps == []
    assert report.source_state is None
    assert report.load_cost.band_tokens == 0

    context_read: LlmRequestContext = _result_value(
        await sdk.thread_view.get_llm_request_context({"filePath": file_path})
    )
    assert all(not _is_band_message(m) for m in context_read.messages)
    assert report.tail.message_count == len(context_read.messages)
    assert report.tail.message_count == 6
    assert report.tail.tokens == _measured(context_read.messages)
    assert report.load_cost.tail_tokens == report.tail.tokens
    assert report.load_cost.total == _measured(context_read.messages)


class _RefuseCallbacks:
    async def smooth_prompt(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def summarize_tool_result(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def compress_detailed_turn(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")

    async def summarize_chunk_brief(self, i: object) -> Never:
        raise RuntimeError("inference callbacks must never be called by a read operation")


async def test_repeated_calls_are_deep_equal_leave_no_delta_and_call_no_model_including_under_a_throwing_inference_callback(
    store: TempStore,
) -> None:
    """repeated calls are deep-equal, leave no delta, and call no model — including under a throwing inference callback"""
    fixture = await _degraded_compacted_thread(store)
    file_path = fixture.file_path
    sdk = fixture.sdk
    captured = fixture.double.capture_inputs()

    first = await expect_read_only(file_path, lambda: sdk.inspect.view({"filePath": file_path}))
    second = await expect_read_only(file_path, lambda: sdk.inspect.view({"filePath": file_path}))
    described_once = await expect_read_only(
        file_path, lambda: sdk.thread_view.describe({"filePath": file_path})
    )
    assert first.ok and second.ok and described_once.ok
    assert second == first
    assert len(captured) == 0

    reader = init_lhc(
        SdkConfig(inference_callbacks=_RefuseCallbacks(), mode="manual")  # type: ignore[arg-type]
    )
    viewed = await expect_read_only(
        file_path, lambda: reader.inspect.view({"filePath": file_path})
    )
    described = await expect_read_only(
        file_path, lambda: reader.thread_view.describe({"filePath": file_path})
    )
    assert viewed.ok and described.ok


async def test_inspect_view_on_a_missing_thread_is_thread_not_found_not_a_shape_error(
    store: TempStore,
) -> None:
    """inspect.view on a missing thread is thread_not_found, not a shape error"""
    sdk = init_lhc(
        SdkConfig(inference_callbacks=create_inference_callbacks_double(), mode="manual")
    )
    missing = await sdk.inspect.view({"filePath": store.thread_path("missing")})
    assert missing.ok is False
    if missing.ok:
        return
    assert missing.error.error_class == "caller_error"
    assert missing.error.code == "thread_not_found"
