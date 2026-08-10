"""Ported from packages/lhc/test/view-fixture.test.ts. Phase 1.

Epic 03 Story 0 foundation checks (FC-0.1–FC-0.6).
"""

from __future__ import annotations

import re

import pytest
import pytest_asyncio

from lhc import Lhc, init_lhc, messages, turns
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.view import (
    PartialVisibilityBudgets,
    PartialViewProfilePercentages,
    SdkViewConfig,
    ViewProfile,
    ViewProfileOverride,
    ViewProfilePercentages,
    VisibilityBudgets,
)
from fixtures import (
    PERMANENT_FAILURE_REASON,
    RATE_LIMIT_FAILURE_REASON,
    DerivedThreadFixture,
    TempStore,
    blocked_sibling_thread,
    corrupted_variant_thread,
    create_inference_callbacks_double,
    derived_thread_fixture,
    fire_view_injection,
    open_raw,
    set_view_injection_hook,
    temp_store,
    valid_event,
)


@pytest.fixture(autouse=True)
def _clear_compact_write_injection_hook() -> None:
    """Mirror TS afterEach: setViewInjectionHook("compact-write", null).

    Explicit in-test cleanup does not run on failure; the hook dict is
    interpreter-global.
    """
    yield
    set_view_injection_hook("compact-write", None)


# NOTE (Phase 2): Partial<SdkConfig> / optional view — closed TypedDict not used;
# SdkViewConfig dataclass fields are already optional.
def _manual_sdk(view: SdkViewConfig | None = None) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=create_inference_callbacks_double(),
            mode="manual",
            view=view,
        )
    )


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def fixture_pair() -> tuple[TempStore, DerivedThreadFixture]:
    store = temp_store()
    try:
        fixture = await derived_thread_fixture(store)
        yield store, fixture
    finally:
        store.cleanup()


@pytest.fixture(scope="module")
def store(fixture_pair: tuple[TempStore, DerivedThreadFixture]) -> TempStore:
    return fixture_pair[0]


@pytest.fixture(scope="module")
def fixture(fixture_pair: tuple[TempStore, DerivedThreadFixture]) -> DerivedThreadFixture:
    return fixture_pair[1]


def test_creates_the_three_view_tables_with_their_check_constraints_and_seeds_the_boundary_at_0(
    fixture: DerivedThreadFixture,
) -> None:
    """creates the three view tables with their CHECK constraints and seeds the boundary at 0"""
    db = open_raw(fixture.file_path)
    try:
        version = db.prepare("PRAGMA user_version").get()
        assert int(version["user_version"] if version else 0) == 6  # type: ignore[index]

        tables = [
            str(row["name"])
            for row in db.prepare(
                """SELECT name FROM sqlite_master WHERE type = 'table'
             AND name IN ('thread_view', 'thread_view_band', 'view_boundary') ORDER BY name"""
            ).all()
        ]
        assert tables == ["thread_view", "thread_view_band", "view_boundary"]

        # The boundary singleton is seeded at position 0 (everything full).
        boundary = db.prepare(
            "SELECT thread_singleton, position, updated_at FROM view_boundary"
        ).all()
        assert len(boundary) == 1
        assert int(boundary[0]["thread_singleton"]) == 1  # type: ignore[arg-type]
        assert int(boundary[0]["position"]) == 0  # type: ignore[arg-type]
        assert len(str(boundary[0]["updated_at"])) > 0

        # Singleton CHECKs enforce structurally: a second view row or a second
        # boundary row cannot exist (failed inserts, nothing mutated).
        with pytest.raises(Exception, match=r"CHECK"):
            db.prepare(
                """INSERT INTO thread_view (singleton, view_id, created_at, compact_point,
               covered_from, config_json, arrangement_json, gaps_json, source_state_json)
             VALUES (2, 'v1', 'now', 0, 0, '{}', '[]', '[]', '{}')"""
            ).run()
        with pytest.raises(Exception, match=r"CHECK"):
            db.prepare(
                "INSERT INTO view_boundary (thread_singleton, position, updated_at) VALUES (2, 0, 'now')"
            ).run()

        # The band table pins its band vocabulary and cascade in the DDL.
        band_ddl = str(
            (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'thread_view_band'").get() or {})[
                "sql"
            ]
        )
        assert "CHECK (band IN ('brief','detailed','smooth'))" in band_ddl
        assert "ON DELETE CASCADE" in band_ddl
    finally:
        db.close()


def test_rejects_a_profile_whose_band_percentages_do_not_sum_to_100() -> None:
    """rejects a profile whose band percentages do not sum to 100"""
    with pytest.raises(
        Exception,
        match=r'profile "skewed": percentages must sum to 100, got 105',
    ):
        _manual_sdk(
            SdkViewConfig(
                profiles=[
                    ViewProfileOverride(
                        name="skewed",
                        lower_bound=50000,
                        percentages=PartialViewProfilePercentages(
                            full=30, smooth=35, detailed=20, brief=20
                        ),
                    )
                ]
            )
        )


def test_rejects_visibility_budgets_violating_max_gt_target_naming_the_constraint() -> None:
    """rejects visibility budgets violating max > target, naming the constraint"""
    with pytest.raises(
        Exception,
        match=r"visibility\.maxTokens \(24000\) must be greater than targetTokens \(24000\)",
    ):
        _manual_sdk(
            SdkViewConfig(
                visibility=PartialVisibilityBudgets(max_tokens=24000, target_tokens=24000)
            )
        )


def test_rejects_a_non_positive_lower_bound() -> None:
    """rejects a non-positive lower bound"""
    with pytest.raises(
        Exception,
        match=r'profile "hollow": lowerBound must be a positive number, got 0',
    ):
        _manual_sdk(
            SdkViewConfig(
                profiles=[
                    ViewProfileOverride(
                        name="hollow",
                        lower_bound=0,
                        percentages=PartialViewProfilePercentages(
                            full=25, smooth=35, detailed=20, brief=20
                        ),
                    )
                ]
            )
        )


def test_rejects_a_partial_profile_that_overrides_no_built_in() -> None:
    """rejects a partial profile that overrides no built-in (unknown override target)"""
    with pytest.raises(
        Exception,
        match=r'profile "mystery" is partial but overrides no built-in \(unknown built-in override target\)',
    ):
        _manual_sdk(SdkViewConfig(profiles=[ViewProfileOverride(name="mystery", lower_bound=64000)]))


def test_resolves_defaults_and_merges_a_built_in_override_field_wise() -> None:
    """resolves defaults and merges a built-in override field-wise"""
    sdk = _manual_sdk(SdkViewConfig(profiles=[ViewProfileOverride(name="coding", lower_bound=64000)]))
    assert sdk.config.view.visibility == VisibilityBudgets(max_tokens=64000, target_tokens=32000)
    assert sdk.config.view.compact_threshold == 160000
    # The override replaced only the named field; the built-in's percentages
    # survive, and the other built-ins are untouched.
    assert sdk.config.view.profiles["coding"] == ViewProfile(
        name="coding",
        lower_bound=64000,
        percentages=ViewProfilePercentages(full=25, smooth=35, detailed=20, brief=20),
    )
    assert sdk.config.view.profiles["continuation"] == ViewProfile(
        name="continuation",
        lower_bound=120000,
        percentages=ViewProfilePercentages(full=30, smooth=30, detailed=20, brief=20),
    )
    assert sdk.config.view.profiles["conversation"].percentages == ViewProfilePercentages(
        full=12, smooth=48, detailed=20, brief=20
    )


async def test_ready_every_turn_rendering_and_the_closed_chunks_summaries_read_back_ready(
    fixture: DerivedThreadFixture,
) -> None:
    """ready: every turn rendering and the closed chunks' summaries read back ready through turns.report"""
    report = await turns.report({"filePath": fixture.file_path})
    assert report.ok is True
    if not report.ok:
        return
    renderings = [entry for entry in report.value if entry.derivation_type == "turn_rendering"]
    assert sorted(entry.subject_id for entry in renderings) == sorted(fixture.turn_ids)
    for rendering in renderings:
        assert rendering.state == "ready"
        assert rendering.content is not None
    # The fixture's pinned shape: 4 chunks, c1–c3 closed with both summary
    # forms ready (the drain ran their close→summary enqueues to completion).
    assert [f"{chunk['chunkId']}:{chunk['status']}" for chunk in fixture.chunks["chunks"]] == [
        "c1:closed",
        "c2:closed",
        "c3:closed",
        "c4:open",
    ]
    for chunk_id in ["c1", "c2", "c3"]:
        for form in ["chunk_summary_detailed", "chunk_summary_brief"]:
            summary = next(
                (
                    entry
                    for entry in report.value
                    if entry.subject_id == chunk_id and entry.derivation_type == form
                ),
                None,
            )
            assert summary is not None and summary.state == "ready"


async def test_failed_transient_and_failed_permanent_scripted_subjects_read_back_failed(
    fixture: DerivedThreadFixture,
) -> None:
    """failed-transient and failed-permanent: the scripted subjects read back failed through messages.report"""
    from lhc.messages import MessageReportOpts

    report = await messages.report({"filePath": fixture.file_path}, MessageReportOpts(not_ready=True))
    assert report.ok is True
    if not report.ok:
        return
    transient = next(
        (entry for entry in report.value if entry.subject_id == fixture.failed_transient_message_id),
        None,
    )
    assert transient is not None
    assert transient.derivation_type == "tool_result_summary"
    assert transient.state == "failed"
    permanent = next(
        (entry for entry in report.value if entry.subject_id == fixture.failed_permanent_message_id),
        None,
    )
    assert permanent is not None
    assert permanent.derivation_type == "tool_result_summary"
    assert permanent.state == "failed"
    # Terminal failures left no live queue rows behind (DD-1): neither entry
    # carries queue detail.
    assert transient.queue is None
    assert permanent.queue is None


async def test_blocked_real_source_damage_on_the_sacrificial_sibling_lands_the_turn_forms_blocked(
    store: TempStore,
) -> None:
    """blocked: real source damage on the sacrificial sibling lands the turn forms blocked"""
    sibling = await blocked_sibling_thread(store)
    report = await turns.report({"filePath": sibling.file_path})
    assert report.ok is True
    if not report.ok:
        return
    blocked = [
        entry
        for entry in report.value
        if entry.subject_id == sibling.blocked_turn_id and entry.state == "blocked"
    ]
    assert sorted(entry.derivation_type for entry in blocked) == [
        "pre_detailed_assembly",
        "turn_rendering",
    ]
    for entry in blocked:
        assert re.match(r"^source_damaged: turn state corrupt", entry.reason or "")


async def test_failed_derivations_persist_the_attempts_reason_class(
    fixture: DerivedThreadFixture,
) -> None:
    """failed derivations persist the attempt's reason class"""
    from lhc.messages import MessageReportOpts

    report = await messages.report({"filePath": fixture.file_path}, MessageReportOpts(not_ready=True))
    assert report.ok is True
    if not report.ok:
        return
    transient = next(
        (entry for entry in report.value if entry.subject_id == fixture.failed_transient_message_id),
        None,
    )
    permanent = next(
        (entry for entry in report.value if entry.subject_id == fixture.failed_permanent_message_id),
        None,
    )

    assert transient is not None and transient.reason == RATE_LIMIT_FAILURE_REASON
    assert re.match(r"^rate_limit:", transient.reason or "")

    assert permanent is not None and permanent.reason == PERMANENT_FAILURE_REASON
    assert re.match(r"^content_refusal:", permanent.reason or "")

    # The classes are distinguishable on read-back.
    assert transient.reason != permanent.reason


async def test_the_corruption_variant_refuses_canonical_consumption_with_state_corruption(
    store: TempStore,
) -> None:
    """the corruption variant refuses canonical consumption with state_corruption naming the damage"""
    corrupted = await corrupted_variant_thread(store)
    refused = await corrupted.sdk.intake_stream.message_events(
        {"filePath": corrupted.file_path},
        [valid_event("user_prompt", {"payload": {"text": "after the damage"}})],
    )
    assert refused.ok is False
    if refused.ok:
        return
    assert refused.error.error_class == "state_corruption"
    assert refused.error.code == "turn_state_corrupt"
    assert re.search(r"open turns", refused.error.reason)


def test_uninstalled_the_point_is_a_no_op() -> None:
    """uninstalled, the point is a no-op"""
    fire_view_injection("compact-write")


def test_an_installed_hook_fires_its_throw_propagates_and_uninstalling_restores_the_no_op() -> None:
    """an installed hook fires, its throw propagates, and uninstalling restores the no-op"""
    fired: list[str] = []
    set_view_injection_hook("compact-write", lambda: fired.append("compact"))
    fire_view_injection("compact-write")
    assert fired == ["compact"]

    def _crash() -> None:
        raise RuntimeError("injected crash between sweep and view write")

    set_view_injection_hook("compact-write", _crash)
    with pytest.raises(Exception, match=r"injected crash"):
        fire_view_injection("compact-write")

    set_view_injection_hook("compact-write", None)
    fired.clear()
    fire_view_injection("compact-write")
    assert fired == []
