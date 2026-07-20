"""Ported from packages/lhc/test/logging-surface.test.ts. Phase 1.

Flow 5: Derivation Logging
"""

from __future__ import annotations

import pytest

from lhc import (
    DrainReport,
    InferenceCallbacks,
    Lhc,
    LogEntry,
    LogLevel,
    MessageEventInput,
    count_live_items,
    create_deterministic_inference_callbacks,
    init_lhc,
    set_scheduler_poke,
    set_thread_touch,
    write_log,
)
from lhc.shared_tech.derivation import LeaseConfig, SdkConfig
from lhc.shared_tech.logging import LogEntry as LogEntryDataclass
from fixtures import (
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    register_test_work_handlers,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


@pytest.fixture
def sdk():
    return init_lhc(
        SdkConfig(
            inference_callbacks=create_deterministic_inference_callbacks(),
            mode="manual",
        )
    )


@pytest.fixture(autouse=True)
def _cleanup_seams():
    yield
    set_scheduler_poke(None)
    set_thread_touch(None)


async def _new_thread(store, sdk: Lhc) -> str:
    file_path = store.thread_path("logging-test")
    created = await sdk.threads.new_thread(
        {"filePath": file_path, "registryPath": store.registry_path}
    )
    assert created.ok is True
    return file_path


async def _write(sdk: Lhc, file_path: str, entry: LogEntry) -> None:
    written = await sdk.logging.write({"filePath": file_path}, entry)
    assert written.ok is True


def _manual_sdk(inference_callbacks: InferenceCallbacks) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
        )
    )


async def _send(target: Lhc, file_path: str, batch: list[MessageEventInput]) -> None:
    result = await target.intake_stream.message_events({"filePath": file_path}, batch)
    assert result.ok is True


async def _drain(target: Lhc, file_path: str) -> DrainReport:
    result = await target.work.drain({"filePath": file_path})
    assert result.ok is True
    if not result.ok:
        raise RuntimeError("drain failed")
    return result.value


def _live_count(file_path: str) -> int:
    db = open_raw(file_path)
    try:
        return count_live_items(db)
    finally:
        db.close()


async def _send_turn(target: Lhc, file_path: str) -> None:
    await _send(
        target,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": "raw prompt one"}}),
            valid_event("assistant_text", {"payload": {"text": "answer text"}}),
            valid_event("turn_end"),
        ],
    )


async def test_tc_5_1a_persists_info_warning_and_error_levels(store, sdk) -> None:
    """TC-5.1a persists info, warning, and error levels"""
    file_path = await _new_thread(store, sdk)
    for level in ("info", "warning", "error"):
        await _write(sdk, file_path, LogEntryDataclass(level=level, message=f"{level} message"))
    queried = await sdk.logging.query({"filePath": file_path}, {})  # type: ignore[attr-defined]
    assert queried.ok is True
    if not queried.ok:
        return
    assert sorted(entry.level for entry in queried.value) == ["error", "info", "warning"]


async def test_tc_5_2a_writes_internal_and_external_callers_through_the_same_store(store, sdk) -> None:
    """TC-5.2a writes internal and external callers through the same store"""
    file_path = await _new_thread(store, sdk)
    db = open_raw(file_path)
    try:
        write_log(
            {"db": db, "threadId": "logging-test", "filePath": file_path},  # type: ignore[arg-type]
            LogEntryDataclass(
                level="info",
                message="internal caller",
                derivation_type="smoothed_prompt",
                subject_id="m1",
            ),
        )
    finally:
        db.close()
    await _write(
        sdk,
        file_path,
        LogEntryDataclass(
            level="warning",
            message="external caller",
            derivation_type="tool_result_summary",
            subject_id="m2",
        ),
    )
    queried = await sdk.logging.query({"filePath": file_path}, {})  # type: ignore[attr-defined]
    assert queried.ok is True
    if not queried.ok:
        return
    assert sorted(entry.message for entry in queried.value) == ["external caller", "internal caller"]


async def test_tc_5_3a_keeps_fallback_events_in_the_log_not_on_ready_derivations(store, sdk) -> None:
    """TC-5.3a keeps fallback events in the log, not on ready derivations"""
    file_path = await _new_thread(store, sdk)
    double = create_inference_callbacks_double()
    double.fail_kind("prompt_smoothing", 1, {"reason": "scripted smoothing failure"})
    target = _manual_sdk(double)
    await _send_turn(target, file_path)
    report = await _drain(target, file_path)
    assert [(e.work_item_id, e.disposition) for e in report.ran] == [
        ("w-m1-prompt_smoothing-v1", "failed_terminal"),
        ("w-t1-turn_derivation-v1", "done"),
        ("w-t1-detailed_turn_compression-v1", "done"),
    ]
    read = open_raw(file_path)
    try:
        row = read.prepare(
            "SELECT state, content, reason, gaps, metadata FROM derivation WHERE subject_id = ?"
        ).get("t1")
        assert row is not None
        assert row["state"] == "ready"
        assert row["reason"] is None
        assert row["gaps"] is None
        assert "raw prompt one" in str(row["content"])
        assert row["metadata"] is None
    finally:
        read.close()
    queried = await sdk.logging.query(  # type: ignore[attr-defined]
        {"filePath": file_path}, {"derivationType": "smoothed_prompt"}
    )
    assert queried.ok is True
    if not queried.ok:
        return
    assert len(queried.value) == 1
    assert queried.value[0].derivation_type == "smoothed_prompt"
    assert queried.value[0].subject_id == "m1"
    assert queried.value[0].floor_used == "raw prompt one"


async def test_tc_5_3b_keeps_failed_state_and_reason_on_the_derivation_record(store, sdk) -> None:
    """TC-5.3b keeps failed state and reason on the derivation record"""
    file_path = await _new_thread(store, sdk)
    db = open_raw(file_path)
    try:
        db.prepare(
            """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, reason)
               VALUES (?, ?, ?, ?, ?)"""
        ).run("message", "m2", "tool_result_summary", "failed", "provider_unavailable")
    finally:
        db.close()
    await _write(
        sdk,
        file_path,
        LogEntryDataclass(
            level="error",
            message="diagnostic",
            derivation_type="tool_result_summary",
            subject_id="m2",
            reason="provider_unavailable",
        ),
    )
    read = open_raw(file_path)
    try:
        row = read.prepare("SELECT state, reason FROM derivation WHERE subject_id = ?").get("m2")
        assert row == {"state": "failed", "reason": "provider_unavailable"}
    finally:
        read.close()


async def test_tc_5_4a_queries_by_actionable_fields(store, sdk) -> None:
    """TC-5.4a queries by actionable fields"""
    file_path = await _new_thread(store, sdk)
    await _write(
        sdk,
        file_path,
        LogEntryDataclass(
            level="info",
            message="smoothed ok",
            derivation_type="smoothed_prompt",
            subject_id="m1",
            reason="observed",
        ),
    )
    await _write(
        sdk,
        file_path,
        LogEntryDataclass(
            level="warning",
            message="tool fallback",
            derivation_type="tool_result_summary",
            subject_id="m2",
            reason="not_ready",
        ),
    )
    await _write(
        sdk,
        file_path,
        LogEntryDataclass(
            level="warning",
            message="smoothed fallback",
            derivation_type="smoothed_prompt",
            subject_id="m3",
            reason="not_ready",
        ),
    )
    queried = await sdk.logging.query(  # type: ignore[attr-defined]
        {"filePath": file_path},
        {"level": "warning", "derivationType": "smoothed_prompt", "reason": "not_ready"},
    )
    assert queried.ok is True
    if not queried.ok:
        return
    assert [entry.message for entry in queried.value] == ["smoothed fallback"]


async def test_tc_5_5a_contains_logging_write_failures(store, sdk) -> None:
    """TC-5.5a contains logging write failures"""
    file_path = await _new_thread(store, sdk)
    db = open_raw(file_path)
    try:
        db.exec("BEGIN IMMEDIATE;")
        try:
            db.prepare(
                """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content)
                   VALUES (?, ?, ?, ?, ?)"""
            ).run("turn", "t1", "turn_rendering", "ready", "turn content")

            class BoomDb:
                def prepare(self, sql: str):
                    raise RuntimeError("log store unavailable")

            write_log(
                {
                    "db": BoomDb(),
                    "clock": lambda: __import__("datetime").datetime(2026, 1, 1),
                    "threadId": "logging-test",
                    "filePath": file_path,
                },  # type: ignore[arg-type]
                LogEntryDataclass(level="warning", message="will be dropped"),
            )

            db.prepare(
                """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content)
                   VALUES (?, ?, ?, ?, ?)"""
            ).run("turn", "t1", "detailed_turn_compression", "ready", "projection content")
            db.exec("COMMIT;")
        except Exception:
            db.exec("ROLLBACK;")
            raise
        rows = db.prepare(
            "SELECT derivation_type FROM derivation WHERE subject_id = ? ORDER BY derivation_type"
        ).all("t1")
        assert [row["derivation_type"] for row in rows] == [
            "detailed_turn_compression",
            "turn_rendering",
        ]
    finally:
        db.close()


async def test_tc_5_5b_keeps_log_writes_outside_caller_rollbacks_in_a_real_store(store, sdk) -> None:
    """TC-5.5b keeps log writes outside caller rollbacks in a real store"""
    file_path = await _new_thread(store, sdk)
    await _write(
        sdk,
        file_path,
        LogEntryDataclass(
            level="info",
            message="before rollback",
            derivation_type="turn_rendering",
            subject_id="t-rollback",
            reason="rollback_probe",
        ),
    )
    db = open_raw(file_path)
    try:
        db.exec("BEGIN IMMEDIATE;")
        db.prepare(
            """INSERT INTO derivation (subject_kind, subject_id, derivation_type, state, content)
               VALUES (?, ?, ?, ?, ?)"""
        ).run("turn", "t-rollback", "turn_rendering", "ready", "rolled back content")
        db.exec("ROLLBACK;")
        derivation_rows = db.prepare(
            "SELECT COUNT(*) AS n FROM derivation WHERE subject_id = ?"
        ).get("t-rollback")
        assert derivation_rows is not None
        assert int(derivation_rows["n"]) == 0  # type: ignore[index]
    finally:
        db.close()
    queried = await sdk.logging.query({"filePath": file_path}, {"subjectId": "t-rollback"})  # type: ignore[attr-defined]
    assert queried.ok is True
    if not queried.ok:
        return
    assert [entry.message for entry in queried.value] == ["before rollback"]


async def test_background_logging_write_catches_up_leftover_work_logging_query_stays_read_only(
    store, sdk
) -> None:
    """background logging.write catches up leftover work; logging.query stays read-only"""
    file_path = await _new_thread(store, sdk)
    await _send_turn(sdk, file_path)
    assert _live_count(file_path) == 2

    double = create_inference_callbacks_double()
    background = init_lhc(
        SdkConfig(
            inference_callbacks=double,
            mode="background",
            lease=LeaseConfig(duration_ms=1000),
        )
    )
    register_test_work_handlers(background, double)

    queried = await background.logging.query({"filePath": file_path}, {})  # type: ignore[attr-defined]
    assert queried.ok is True
    await background.drain_settled({"filePath": file_path})  # type: ignore[attr-defined]
    assert _live_count(file_path) == 2
    assert [form.state for form in read_derived_forms(file_path)] == ["pending", "pending", "pending"]

    written = await background.logging.write(
        {"filePath": file_path}, LogEntryDataclass(level="info", message="background touch")
    )
    assert written.ok is True
    await background.drain_settled({"filePath": file_path})  # type: ignore[attr-defined]
    assert _live_count(file_path) == 0
    assert [form.state for form in read_derived_forms(file_path)] == [
        "ready",
        "ready",
        "ready",
        "ready",
    ]
