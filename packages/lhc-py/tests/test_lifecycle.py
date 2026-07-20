"""Ported from packages/lhc/test/lifecycle.test.ts. Phase 1.

Story 4 (Epic 04): TC-5.1–5.3 — the full-surface lifecycle exercise.

Determinism control: TS freezes Date — and only Date — via
`vi.useFakeTimers({ toFake: ["Date"] })` + `setSystemTime`. One async
`beforeAll` computes a shared baseline; checkpoint tests are synchronous
against that baseline. Translated as a module-scoped async fixture.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from contextlib import ExitStack
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import pytest_asyncio

from lhc.messages import MutationResult
from lhc.shared_tech.derivation import DerivationReportEntry
from lhc.shared_tech.errors import OpResult
from lhc.shared_tech.inspect import HealthQueue
from lhc.shared_tech.token_counting import estimate_tokens
from lhc.shared_tech.view import LlmRequestContext, LlmRequestContextMessage, ViewStatusDerivation
from fixtures import (
    DELETED_MESSAGE_TEXT,
    EDITED_MESSAGE_TEXT,
    LIFECYCLE_PROFILE,
    LifecycleOptions,
    LifecycleRun,
    TempStore,
    run_lifecycle,
    temp_store,
)

pytestmark = pytest.mark.asyncio(loop_scope="module")

_FROZEN_AT = datetime(2026, 6, 12, 0, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def _freeze_date_only():
    """Mirror `vi.useFakeTimers({ toFake: ["Date"] })` + setSystemTime — Date only.

    Phase 2 preference: inject the clock through the SDK seam rather than
    patching datetime (this freeze exists only to match the TS harness).
    """
    real_datetime = datetime

    class _FrozenDateTimeMeta(type(real_datetime)):
        def __instancecheck__(cls, instance: object) -> bool:
            # Preserve isinstance(real_dt, datetime) after patching the name
            # `datetime` to FrozenDateTime.
            return isinstance(instance, real_datetime)

    class FrozenDateTime(real_datetime, metaclass=_FrozenDateTimeMeta):
        @classmethod
        def now(cls, tz: Any = None) -> datetime:
            if tz is None:
                return real_datetime(
                    _FROZEN_AT.year,
                    _FROZEN_AT.month,
                    _FROZEN_AT.day,
                    _FROZEN_AT.hour,
                    _FROZEN_AT.minute,
                    _FROZEN_AT.second,
                    _FROZEN_AT.microsecond,
                )
            return _FROZEN_AT.astimezone(tz)

        @classmethod
        def utcnow(cls) -> datetime:
            return cls.now()

    # `vi.useFakeTimers` reaches every Date call site; patching only the
    # datetime module misses modules that did `from datetime import datetime`
    # before this fixture ran — patch those aliases too.
    with ExitStack() as stack:
        stack.enter_context(patch("datetime.datetime", FrozenDateTime))
        for name, mod in list(sys.modules.items()):
            if mod is None or not (
                name == "fixtures"
                or name.startswith(("lhc", "tests", "fixtures."))
            ):
                continue
            if getattr(mod, "datetime", None) is real_datetime:
                stack.enter_context(patch.object(mod, "datetime", FrozenDateTime))
        yield


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def baseline(_freeze_date_only: None) -> tuple[TempStore, LifecycleRun]:
    """One shared baseline — TS `beforeAll` computing `run` once for the suite."""
    store = temp_store()
    try:
        run = await run_lifecycle(store, LifecycleOptions(name="baseline"))
        yield store, run
    finally:
        store.cleanup()


@pytest.fixture(scope="module")
def store(baseline: tuple[TempStore, LifecycleRun]) -> TempStore:
    return baseline[0]


@pytest.fixture(scope="module")
def run(baseline: tuple[TempStore, LifecycleRun]) -> LifecycleRun:
    return baseline[1]


def _ok(result: OpResult[object]) -> object:
    if not result.ok:
        raise RuntimeError(
            f"expected ok result: {json.dumps(_to_jsonable(result.error), separators=(',', ':'))}"
        )
    return result.value


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _message_text(message: LlmRequestContextMessage) -> str:
    return "".join(part.text for part in message.content)


def _is_band_message(message: LlmRequestContextMessage) -> bool:
    return _message_text(message).startswith("[context ·")


def _measured(messages: list[LlmRequestContextMessage]) -> int:
    return sum(estimate_tokens(_message_text(message)) for message in messages)


def _comparable_context(context: LlmRequestContext) -> dict[str, object]:
    return {"threadId": "<threadId>", "messages": context.messages}


def _to_jsonable(value: Any) -> Any:
    """Recursive dataclass→JSON-compatible value; dict keys stay as given (camelCase data keys)."""
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


def _json_stringify(value: object) -> str:
    """JSON.stringify semantics: compact separators, no default=str."""
    return json.dumps(_to_jsonable(value), separators=(",", ":"))


def _cleared_keys(*mutations: MutationResult) -> list[str]:
    keys = [
        f"{target.subject_kind}:{target.subject_id}:{target.derivation_type}"
        for mutation in mutations
        for target in mutation.cleared
    ]
    return sorted(keys)


def _pending_keys(*reports: list[DerivationReportEntry]) -> list[str]:
    keys = [
        f"{entry.subject_kind}:{entry.subject_id}:{entry.derivation_type}"
        for report in reports
        for entry in report
        if entry.state == "pending"
    ]
    return sorted(keys)


def _comparable_session_file(lifecycle_run: LifecycleRun) -> str:
    return Path(lifecycle_run.out_path).read_text(encoding="utf-8").replace(
        lifecycle_run.thread_id, "<thread-id>"
    )


async def test_every_phase_operation_returns_ok_with_deterministic_inference_callbacks(
    run: LifecycleRun,
) -> None:
    """every phase operation returns ok with deterministic inference callbacks"""
    phases = run.phases
    assert phases.create.ok is True
    # Anti-vacuous guard: 12 turns intake in batches of 3.
    assert len(phases.intake) == 4
    for batch in phases.intake:
        assert batch.ok is True
    assert phases.drain.settled is True
    assert phases.status.ok is True
    assert phases.compact1.ok is True
    assert phases.llm_context1.ok is True
    assert phases.inspect1.overview.ok is True
    assert phases.inspect1.view.ok is True
    assert phases.inspect1.health.ok is True
    assert phases.mutate.edit.ok is True
    assert phases.mutate.delete.ok is True
    assert phases.mutate.health_after_mutate.ok is True
    assert phases.rebuild.settled is True
    assert phases.health2.ok is True
    assert phases.compact2.ok is True
    assert phases.llm_context2.ok is True
    assert phases.materialize.ok is True


async def test_status_recommends_the_compact_the_sequence_performs_next_with_derivation_settled(
    run: LifecycleRun,
) -> None:
    """status recommends the compact the sequence performs next, with derivation settled"""
    status = _ok(run.phases.status)
    assert status.threshold == 300
    assert status.tail_tokens > status.threshold
    assert status.compact_recommended is True
    assert status.derivation == ViewStatusDerivation(pending=0, failed=0, blocked=0)
    assert status.view is None


async def test_post_compact_model_context_serves_bands_tail_and_the_view_reports_load_cost_prices_that_context(
    run: LifecycleRun,
) -> None:
    """post-compact model context serves bands + tail, and the view report's loadCost prices that context"""
    receipt = _ok(run.phases.compact1)
    assert receipt.profile == LIFECYCLE_PROFILE.name
    context = _ok(run.phases.llm_context1)

    bands = [message for message in context.messages if _is_band_message(message)]
    assert [
        (re.match(r"^\[context · ([^\]]+)\]", _message_text(message)) or [None, None])[1]
        for message in bands
    ] == ["brief", "detailed", "smooth"]
    assert context.messages[: len(bands)] == bands
    tail = context.messages[len(bands) :]
    assert len(tail) > 0

    report = _ok(run.phases.inspect1.view)
    assert report.meta is not None
    assert report.meta.view_id == receipt.view_id
    assert report.meta.profile == LIFECYCLE_PROFILE.name
    assert report.load_cost.band_tokens == _measured(bands)
    assert report.load_cost.tail_tokens == _measured(tail)
    assert report.load_cost.total == _measured(context.messages)

    overview = _ok(run.phases.inspect1.overview)
    assert overview.view is not None
    assert overview.view.view_id == receipt.view_id
    assert overview.derivation.pending == 0
    assert overview.messages.deleted == 0


async def test_post_mutation_health_shows_exactly_the_cleared_set_pending_post_drain_health_shows_it_ready(
    run: LifecycleRun,
) -> None:
    """post-mutation health shows exactly the cleared set pending; post-drain health shows it ready"""
    mutate = run.phases.mutate
    edit = _ok(mutate.edit)
    deleted = _ok(mutate.delete)
    assert edit.superseded == []
    assert deleted.superseded == []
    assert deleted.dropped == []

    cleared = _cleared_keys(edit, deleted)
    assert len(cleared) > 0
    pending = _pending_keys(_ok(mutate.messages_not_ready), _ok(mutate.turns_not_ready))
    assert pending == cleared

    health = _ok(mutate.health_after_mutate)
    pending_total = sum(row.counts.pending for row in health.owners)
    assert pending_total == len(cleared)
    assert health.queue == HealthQueue(queued=len(cleared), claimed=0)
    assert len(edit.queued) > 0
    assert len(deleted.queued) > 0
    assert health.failures == []

    after = _ok(run.phases.health2)
    # Anti-vacuous guard: both owners (messages, turns) must report.
    assert len(after.owners) == 2
    for row in after.owners:
        assert row.counts.pending == 0
        assert row.counts.failed == 0
        assert row.counts.blocked == 0
        assert row.counts.ready > 0
    assert after.failures == []
    assert after.repair_preview == []
    assert after.queue == HealthQueue(queued=0, claimed=0)


async def test_the_second_compacts_view_reflects_post_edit_content(run: LifecycleRun) -> None:
    """the second compact's view reflects post-edit content"""
    llm_context1 = _ok(run.phases.llm_context1)
    llm_context2 = _ok(run.phases.llm_context2)

    assert any(
        _message_text(m) == "turn 12: please investigate area 12" for m in llm_context1.messages
    )
    assert any(_message_text(m) == DELETED_MESSAGE_TEXT for m in llm_context1.messages)

    assert any(
        (not _is_band_message(m)) and m.role == "user" and _message_text(m) == EDITED_MESSAGE_TEXT
        for m in llm_context2.messages
    )
    assert not any(DELETED_MESSAGE_TEXT in _message_text(m) for m in llm_context2.messages)
    assert not any(
        _message_text(m) == "turn 12: please investigate area 12" for m in llm_context2.messages
    )


async def test_produces_hash_equal_llm_request_context_outputs_and_a_byte_identical_materialized_file(
    store: TempStore,
    run: LifecycleRun,
) -> None:
    """produces hash-equal LlmRequestContext outputs and a byte-identical materialized file (modulo the one random thread id)"""
    replay = await run_lifecycle(store, LifecycleOptions(name="replay"))

    contexts = [
        (run.phases.llm_context1, replay.phases.llm_context1),
        (run.phases.llm_context2, replay.phases.llm_context2),
    ]
    for original, replayed in contexts:
        assert _sha256(_json_stringify(_comparable_context(_ok(replayed)))) == _sha256(
            _json_stringify(_comparable_context(_ok(original)))
        )

    assert replay.thread_id != run.thread_id
    assert _sha256(_comparable_session_file(replay)) == _sha256(_comparable_session_file(run))


async def test_yields_final_llm_request_context_health_and_materialized_file_identical_to_the_uninterrupted_runs(
    store: TempStore,
    run: LifecycleRun,
) -> None:
    """yields final LlmRequestContext, health, and materialized file identical to the uninterrupted run's"""
    teardown = await run_lifecycle(
        store,
        LifecycleOptions(name="teardown", fresh_sdk_between_groups=True),
    )

    assert _json_stringify(_comparable_context(_ok(teardown.phases.llm_context2))) == _json_stringify(
        _comparable_context(_ok(run.phases.llm_context2))
    )
    assert _ok(teardown.phases.health2) == _ok(run.phases.health2)
    assert _sha256(_comparable_session_file(teardown)) == _sha256(_comparable_session_file(run))
