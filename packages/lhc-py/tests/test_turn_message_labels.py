"""Smooth-history labels (R3): short XML tags whose name is the entity id
(<t1>…</t1>, <m2>…</m2>). turn_rendering carries them; pre_detailed_assembly
(compression input) does not. Chunk bands get <turns>…</turns> at serve time,
including unavailable/gap entries. Legacy unlabeled stored renderings recompose
when labels are required; already-labeled renderings are not double-labeled.

Ported from packages/lhc/test/turn-message-labels.test.ts at pin 81cd48c.
Rust trap map (same pin): packages/lhc-rs/tests/turn_message_labels.rs.

No source-text inspection. Behavioral byte/data parity only.
R5 owns token-total truncation marker translation; not asserted here.
"""

from __future__ import annotations

import re

import pytest

from lhc import Lhc, create_deterministic_inference_callbacks, init_lhc
from lhc.messages import RemoveInput
from lhc.shared_tech.derivation import RenderingPartKind, SdkConfig
from lhc.shared_tech.token_counting import estimate_tokens
from lhc.shared_tech.view import PartialViewProfilePercentages, ViewCompactParams
from lhc.thread_view import CompactOpts
from lhc.thread_view.internal.render import (
    ResolvedRepresentation,
    render_arrangement_entry,
    resolve_smooth_representation,
)
from lhc.thread_view.internal.select import read_selection_inputs
from lhc.turns.internal.compose import (
    ComposeBlock,
    ComposeDerivationRow,
    ComposeMessage,
    compose_derivation_key,
    compose_pre_detailed_assembly,
    compose_rendering_input,
    compose_structured_turn_text,
    format_turn_range_header,
    labeled_or_recomposed_turn_rendering,
    stored_rendering_has_turn_label,
    wrap_entity_xml,
)
from lhc.turns.internal.derivations import (
    read_member_messages,
    read_message_derivation_rows,
)
from fixtures import TempStore, open_raw, read_derived_forms, temp_store, valid_event


def _msg(
    message_id: str,
    kind: RenderingPartKind,
    content: dict[str, object],
) -> ComposeMessage:
    return ComposeMessage(
        message_id=message_id,
        kind=kind,
        blocks=[ComposeBlock(block_type=kind, content=content)],
    )


def _text(text: str) -> dict[str, object]:
    return {"text": text}


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


def _manual_sdk() -> Lhc:
    return init_lhc(
        SdkConfig(
            mode="manual",
            inference_callbacks=create_deterministic_inference_callbacks(),
        )
    )


async def _new_thread(sdk: Lhc, store: TempStore) -> str:
    path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return path


# ── pure helpers ─────────────────────────────────────────────────────


def test_wrap_entity_xml_uses_the_id_as_the_tag_name() -> None:
    assert wrap_entity_xml("m12", "hello") == "<m12>\nhello\n</m12>"
    assert wrap_entity_xml("t3", "body") == "<t3>\nbody\n</t3>"


def test_compose_structured_turn_text_wraps_the_turn_and_each_non_run_message() -> None:
    messages = [
        _msg("m1", "user_prompt", _text("please read")),
        _msg("m2", "assistant_text", _text("done")),
    ]
    composition = compose_rendering_input(messages, {})
    text = compose_structured_turn_text(composition.parts, "t1")
    assert text.startswith("<t1>\n")
    assert text.endswith("\n</t1>")
    assert "<m1>\n" in text
    assert "</m1>" in text
    assert "<m2>\n" in text
    assert "done" in text
    assert "User prompt" in text
    assert "Assistant response\n" in text


def test_compose_structured_turn_text_tags_each_tool_run_member_line() -> None:
    messages = [
        _msg("m1", "user_prompt", _text("go")),
        _msg(
            "m2",
            "tool_call",
            {
                "toolCallId": "c1",
                "toolName": "read",
                "arguments": {"path": "a.ts"},
            },
        ),
        _msg(
            "m3",
            "tool_result",
            {"toolCallId": "c1", "content": "file body", "isError": False},
        ),
        _msg("m4", "assistant_text", _text("ok")),
    ]
    composition = compose_rendering_input(messages, {})
    run = next(
        (part for part in composition.parts if part.member_message_ids is not None),
        None,
    )
    assert run is not None
    assert run.member_message_ids == ["m2", "m3"]
    assert "<m2>" in run.text
    assert "</m2>" in run.text
    assert "<m3>" in run.text
    assert "file body" in run.text

    text = compose_structured_turn_text(composition.parts, "t9")
    assert "<t9>" in text
    # Run body is not double-wrapped in the lead message id.
    assert "<m2>\n[tool run" not in text


def test_mixed_text_tool_turn_exact_wire_format_and_contract_order() -> None:
    """P2: exact byte golden + section order for mixed text/tool (no snapshots)."""
    messages = [
        _msg("m1", "user_prompt", _text("go")),
        _msg(
            "m2",
            "tool_call",
            {
                "toolCallId": "c1",
                "toolName": "read",
                "arguments": {"path": "a.ts"},
            },
        ),
        _msg(
            "m3",
            "tool_result",
            {"toolCallId": "c1", "content": "file body", "isError": False},
        ),
        _msg("m4", "assistant_text", _text("ok")),
    ]
    composition = compose_rendering_input(messages, {})
    text = compose_structured_turn_text(composition.parts, "t9")
    # Exact wire format (pin composeStructuredTurnText + composeRun labels).
    # Empty derivations ⇒ prompt/tool floors land as fallback annotations.
    expected = (
        "<t9>\n"
        "User prompt [fallback]\n"
        "<m1>\n"
        "go\n"
        "</m1>\n"
        "\n"
        "Tool call [fallback; outcome: succeeded]\n"
        "[tool run · read · 1 call · 1 succeeded]\n"
        '<m2>read({"path":"a.ts"}) ⇒ succeeded</m2>\n'
        "<m3>file body ⇒ succeeded</m3>\n"
        "\n"
        "Assistant response\n"
        "<m4>\n"
        "ok\n"
        "</m4>\n"
        "</t9>"
    )
    assert text == expected
    # Contract order: user → tool run (m2 then m3) → assistant; single outer wrap.
    assert text.index("User prompt") < text.index("[tool run")
    assert text.index("<m2>") < text.index("<m3>")
    assert text.index("<m3>") < text.index("Assistant response")
    assert text.count("<t9>") == 1
    assert text.count("</t9>") == 1
    assert "<m2>\n[tool run" not in text


def test_pre_detailed_assembly_stays_untagged() -> None:
    messages = [
        _msg("m1", "user_prompt", _text("please read")),
        _msg("m2", "assistant_text", _text("done")),
    ]
    assembly = compose_pre_detailed_assembly(messages, {})
    assert "<m" not in assembly.text
    assert "<t" not in assembly.text
    assert "User:\n" in assembly.text
    assert "⏺ " in assembly.text


def test_format_turn_range_header_lists_member_turn_ids() -> None:
    assert format_turn_range_header(["t1", "t2", "t3"]) == "<turns>t1 t2 t3</turns>"
    assert format_turn_range_header([]) == ""


def test_prefixes_unavailable_chunk_entries_as_well_as_ready_summaries() -> None:
    rep = ResolvedRepresentation(
        derivation_used="gap",
        body="",
        degraded=False,
        gap=True,
        reason="not ready",
    )
    text = render_arrangement_entry("chunk", "c1", rep, [], ["t1", "t2"])
    assert text == "<turns>t1 t2</turns>\n[chunk unavailable: not ready]"


def test_ready_chunk_entry_also_gets_turns_header() -> None:
    rep = ResolvedRepresentation(
        derivation_used="chunk_summary_detailed",
        body="chunk body",
        degraded=False,
        gap=False,
    )
    text = render_arrangement_entry("chunk", "c1", rep, [], ["t3", "t4"])
    assert text == "<turns>t3 t4</turns>\nchunk body"


def test_turn_entries_do_not_get_turns_header() -> None:
    rep = ResolvedRepresentation(
        derivation_used="turn_rendering",
        body="<t1>\nbody\n</t1>",
        degraded=False,
        gap=False,
    )
    text = render_arrangement_entry("turn", "t1", rep, [], ["t1"])
    # member_turn_ids ignored for turn subjects; smooth body already has <t…>.
    assert text == "<t1>\nbody\n</t1>"
    assert "<turns>" not in text


def test_stored_rendering_has_turn_label_detects_legacy_unlabeled() -> None:
    assert stored_rendering_has_turn_label(
        "<t1>\nUser prompt\n<m1>\nhi\n</m1>\n</t1>", "t1"
    )
    assert not stored_rendering_has_turn_label("legacy untagged rendering", "t1")
    assert not stored_rendering_has_turn_label("<t2>\nbody\n</t2>", "t1")


def test_already_labeled_rendering_is_not_double_labeled() -> None:
    """Re-composing a labeled body must not nest another outer turn wrap when
    the producer path is pure composeStructuredTurnText (single wrap)."""
    messages = [
        _msg("m1", "user_prompt", _text("once")),
        _msg("m2", "assistant_text", _text("labeled")),
    ]
    composition = compose_rendering_input(messages, {})
    labeled = compose_structured_turn_text(composition.parts, "t1")
    assert labeled.startswith("<t1>\n")
    assert labeled.endswith("\n</t1>")
    # Exactly one outer open/close pair for t1.
    assert labeled.count("<t1>") == 1
    assert labeled.count("</t1>") == 1
    assert stored_rendering_has_turn_label(labeled, "t1")
    # Predicate would keep stored path (R4); re-compose still single-wrap.
    recomposed = compose_structured_turn_text(composition.parts, "t1")
    assert recomposed == labeled
    assert recomposed.count("<t1>") == 1
    # turnCandidate helper: labeled stored content passes through verbatim.
    assert (
        labeled_or_recomposed_turn_rendering("t1", labeled, messages, {}) == labeled
    )
    # Unlabeled stored content recomposes (never returns legacy body).
    recomposed_legacy = labeled_or_recomposed_turn_rendering(
        "t1", "legacy untagged rendering", messages, {}
    )
    assert recomposed_legacy == labeled
    assert "legacy untagged rendering" not in recomposed_legacy


# ── integration: stored rendering + id stability + legacy fallback ───


@pytest.mark.asyncio
async def test_stored_turn_rendering_carries_turn_and_message_labels(
    store: TempStore,
) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "please read"}}),
            valid_event("assistant_text", {"payload": {"text": "done"}}),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok

    forms = read_derived_forms(file_path)
    rendering = next(
        (
            f
            for f in forms
            if f.subject_id == "t1" and f.derivation_type == "turn_rendering"
        ),
        None,
    )
    assert rendering is not None
    text = rendering.content or ""
    assert text.startswith("<t1>\n")
    assert text.endswith("\n</t1>")
    assert "<m1>" in text
    assert "<m2>" in text

    assembly = next(
        (
            f
            for f in forms
            if f.subject_id == "t1" and f.derivation_type == "pre_detailed_assembly"
        ),
        None,
    )
    assert assembly is not None
    assembly_text = assembly.content or ""
    assert "<m" not in assembly_text
    assert "<t" not in assembly_text
    assert "User:\n" in assembly_text


@pytest.mark.asyncio
async def test_labels_stable_across_re_derivation(store: TempStore) -> None:
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "stability check"}}),
            valid_event("assistant_text", {"payload": {"text": "stable answer"}}),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok

    before = next(
        (
            f.content
            for f in read_derived_forms(file_path)
            if f.subject_id == "t1" and f.derivation_type == "turn_rendering"
        ),
        None,
    )
    assert before is not None
    assert before.startswith("<t1>\n")
    assert "<m1>" in before
    assert "<m2>" in before

    db = open_raw(file_path)
    try:
        db.prepare(
            """UPDATE derivation SET state = 'pending', content = NULL
               WHERE subject_kind = 'turn' AND subject_id = 't1'
                 AND derivation_type IN ('turn_rendering', 'pre_detailed_assembly')"""
        ).run()
    finally:
        db.close()

    rederived = await sdk.turns.derive_turn({"filePath": file_path}, "t1")
    assert rederived.ok, getattr(rederived, "error", None)

    after = next(
        (
            f.content
            for f in read_derived_forms(file_path)
            if f.subject_id == "t1" and f.derivation_type == "turn_rendering"
        ),
        None,
    )
    assert after is not None
    assert after.startswith("<t1>\n")
    assert after.endswith("\n</t1>")
    assert "<m1>" in after
    assert "<m2>" in after
    # Same stable ids across re-derivation (message ids are durable).
    assert after.count("<m1>") == before.count("<m1>")
    assert after.count("<m2>") == before.count("<m2>")


@pytest.mark.asyncio
async def test_legacy_unlabeled_stored_rendering_recomposes_when_labels_required(
    store: TempStore,
) -> None:
    # Pure contract mirror of retrieval's storedHasTurnLabel branch (R4 will
    # wire get_turns). R3 owns the predicate + composition path.
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "first question"}}),
            valid_event("assistant_text", {"payload": {"text": "first answer"}}),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok

    db = open_raw(file_path)
    try:
        db.prepare(
            """UPDATE derivation SET content = 'legacy untagged rendering'
               WHERE subject_kind = 'turn' AND subject_id = 't1'
                 AND derivation_type = 'turn_rendering'"""
        ).run()
    finally:
        db.close()

    stored = next(
        (
            f.content
            for f in read_derived_forms(file_path)
            if f.subject_id == "t1" and f.derivation_type == "turn_rendering"
        ),
        None,
    )
    assert stored is not None
    assert not stored_rendering_has_turn_label(stored, "t1")

    # Live composition fallback (same pure path retrieval will use).
    members = [
        _msg("m1", "user_prompt", _text("first question")),
        _msg("m2", "assistant_text", _text("first answer")),
    ]
    composition = compose_rendering_input(members, {})
    composed = compose_structured_turn_text(composition.parts, "t1")
    assert "<t1>" in composed
    assert "<m1>" in composed
    assert "legacy untagged rendering" not in composed
    assert stored_rendering_has_turn_label(composed, "t1")


@pytest.mark.asyncio
async def test_mixed_text_tool_turn_stored_labels_and_smooth_band(
    store: TempStore,
) -> None:
    """End-to-end: mixed text/tool turn stores labels; compact smooth band
    carries them (no double-label); pre_detailed stays untagged."""
    from lhc.shared_tech.view import PartialViewProfilePercentages, ViewCompactParams
    from lhc.thread_view import CompactOpts

    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)

    # Several turns so compact can land a smooth band; last is mixed text/tool.
    for i in range(3):
        captured = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            [
                valid_event("user_prompt", {"payload": {"text": f"seed {i}"}}),
                valid_event("assistant_text", {"payload": {"text": f"reply {i}"}}),
                valid_event("turn_end"),
            ],
        )
        assert captured.ok

    mixed = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": "go"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "c1",
                        "toolName": "read",
                        "arguments": {"path": "a.ts"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "c1",
                        "content": "file body",
                        "isError": False,
                    }
                },
            ),
            valid_event("assistant_text", {"payload": {"text": "ok"}}),
            valid_event("turn_end"),
        ],
    )
    assert mixed.ok
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok

    forms = read_derived_forms(file_path)
    mixed_rendering = next(
        (
            f
            for f in forms
            if f.subject_id == "t4" and f.derivation_type == "turn_rendering"
        ),
        None,
    )
    assert mixed_rendering is not None
    text = mixed_rendering.content or ""
    assert text.startswith("<t4>\n")
    assert text.endswith("\n</t4>")
    # Message ids are thread-global (seeds consume earlier mN); require four
    # distinct m-tags, tool-run body tags, and no lead-id double wrap on run.
    message_ids = re.findall(r"<m(\d+)>", text)
    assert len(message_ids) >= 4
    assert "[tool run" in text
    assert "file body" in text
    assert "User prompt" in text
    assert "Assistant response" in text
    # No double outer wrap of the run body in the lead tool-call message id.
    assert not re.search(r"<m\d+>\n\[tool run", text)
    # Single outer turn wrap.
    assert text.count("<t4>") == 1
    assert text.count("</t4>") == 1

    assembly = next(
        (
            f
            for f in forms
            if f.subject_id == "t4" and f.derivation_type == "pre_detailed_assembly"
        ),
        None,
    )
    assert assembly is not None
    assert "<m" not in (assembly.content or "")
    assert "<t" not in (assembly.content or "")
    assert "<turns>" not in (assembly.content or "")

    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(
            params=ViewCompactParams(
                lower_bound=40,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=75, detailed=0, brief=0
                ),
            )
        ),
    )
    assert compacted.ok, getattr(compacted, "error", None)
    # Smooth band snapshot (serve-time) uses stored turn_rendering, which carries
    # labels. Live tail stays unlabeled raw serve format — that is intentional.
    db = open_raw(file_path)
    try:
        row = db.prepare(
            "SELECT rendered_text FROM thread_view_band WHERE band = 'smooth'"
        ).get()
    finally:
        db.close()
    assert row is not None
    smooth_text = str(row["rendered_text"])
    assert re.search(r"<t\d+>", smooth_text)
    assert re.search(r"<m\d+>", smooth_text)
    for turn_tag in set(re.findall(r"<t(\d+)>", smooth_text)):
        assert smooth_text.count(f"<t{turn_tag}>") == smooth_text.count(
            f"</t{turn_tag}>"
        )
        # No double-label: outer wrap appears once per banded turn id.
        assert smooth_text.count(f"<t{turn_tag}>") == 1


def _expected_recomposed_turn(file_path: str, turn_id: str, stored: str) -> str:
    db = open_raw(file_path)
    try:
        members = read_member_messages(db, turn_id)
        derivations = read_message_derivation_rows(
            db, [message.message_id for message in members]
        )
        return labeled_or_recomposed_turn_rendering(
            turn_id, stored, members, derivations
        )
    finally:
        db.close()


@pytest.mark.asyncio
async def test_legacy_unlabeled_ready_row_recomposes_on_select_before_token_pricing(
    store: TempStore,
) -> None:
    """P1 production path: read_selection_inputs rewrites ready unlabeled
    turn_rendering before resolve/render/estimateTokens (TS turnCandidate)."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    for i in range(3):
        captured = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            [
                valid_event("user_prompt", {"payload": {"text": f"seed {i}"}}),
                valid_event("assistant_text", {"payload": {"text": f"reply {i}"}}),
                valid_event("turn_end"),
            ],
        )
        assert captured.ok
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok

    db = open_raw(file_path)
    try:
        db.prepare(
            """UPDATE derivation SET content = 'legacy untagged rendering'
               WHERE subject_kind = 'turn' AND subject_id = 't1'
                 AND derivation_type = 'turn_rendering'"""
        ).run()
    finally:
        db.close()

    expected = _expected_recomposed_turn(
        file_path, "t1", "legacy untagged rendering"
    )
    assert stored_rendering_has_turn_label(expected, "t1")
    assert "legacy untagged rendering" not in expected

    db = open_raw(file_path)
    try:
        inputs = read_selection_inputs(db)
        snap = inputs.derivations["t1/turn_rendering"]
        assert snap.state == "ready"
        assert snap.content == expected
        assert "legacy untagged rendering" not in (snap.content or "")

        def lookup(subject_id: str, derivation_type: str):
            return inputs.derivations.get(f"{subject_id}/{derivation_type}")

        rep = resolve_smooth_representation("t1", lookup, None)
        assert rep.derivation_used == "turn_rendering"
        assert rep.body == expected
        # Exact production band entry bytes + token pricing (buildTurnEntry).
        entry_text = render_arrangement_entry("turn", "t1", rep, [])
        assert entry_text == expected
        assert estimate_tokens(entry_text) == estimate_tokens(expected)
    finally:
        db.close()

    # Immutable record still holds the legacy bytes (serve-time only rewrite).
    stored = next(
        f.content
        for f in read_derived_forms(file_path)
        if f.subject_id == "t1" and f.derivation_type == "turn_rendering"
    )
    assert stored == "legacy untagged rendering"


@pytest.mark.asyncio
async def test_legacy_unlabeled_compact_band_bytes_and_token_pricing(
    store: TempStore,
) -> None:
    """intake→drain→mutate all ready renderings legacy→compact: band bytes
    and receipt tokens match recomposed labeled text (no legacy leak)."""
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    for i in range(5):
        captured = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            [
                valid_event("user_prompt", {"payload": {"text": f"seed {i}"}}),
                valid_event("assistant_text", {"payload": {"text": f"reply {i}"}}),
                valid_event("turn_end"),
            ],
        )
        assert captured.ok
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok

    db = open_raw(file_path)
    try:
        db.prepare(
            """UPDATE derivation SET content = 'legacy untagged rendering'
               WHERE subject_kind = 'turn'
                 AND derivation_type = 'turn_rendering'"""
        ).run()
    finally:
        db.close()

    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(
            params=ViewCompactParams(
                lower_bound=40,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=75, detailed=0, brief=0
                ),
            )
        ),
    )
    assert compacted.ok, getattr(compacted, "error", None)
    assert compacted.value.bands["smooth"].entries >= 1

    db = open_raw(file_path)
    try:
        row = db.prepare(
            "SELECT rendered_text FROM thread_view_band WHERE band = 'smooth'"
        ).get()
    finally:
        db.close()
    assert row is not None
    band_text = str(row["rendered_text"])
    assert "legacy untagged rendering" not in band_text
    assert re.search(r"<t\d+>", band_text)
    assert re.search(r"<m\d+>", band_text)

    # Each banded turn body equals the live recompose oracle; single wrap.
    turn_ids = re.findall(r"<t(\d+)>", band_text)
    assert len(turn_ids) >= 1
    for turn_num in set(turn_ids):
        turn_id = f"t{turn_num}"
        expected = _expected_recomposed_turn(
            file_path, turn_id, "legacy untagged rendering"
        )
        assert expected in band_text
        assert band_text.count(f"<{turn_id}>") == 1
        assert band_text.count(f"</{turn_id}>") == 1

    # Receipt token pricing is estimate_tokens of the stored band text.
    assert compacted.value.bands["smooth"].tokens == estimate_tokens(band_text)


def _distinctive_labeled_body(turn_id: str) -> str:
    """Valid outer turn label wrap with body bytes that cannot equal canonical
    recompose of ordinary seed turns (unique marker + padding for token cost)."""
    pad = "DISTINCTIVE_TOKEN_PAD_q9x7v2 " * 12
    return (
        f"<{turn_id}>\n"
        f"PASS_THROUGH_MARKER_NOT_FROM_CANONICAL_RECOMPOSE_{turn_id}\n"
        f"{pad}\n"
        f"</{turn_id}>"
    )


@pytest.mark.asyncio
async def test_distinctive_labeled_stored_row_pass_through_kills_recompose_mutants(
    store: TempStore,
) -> None:
    """Mutation-proof pass-through: labeled stored body differs from canonical
    recompose in both bytes and token cost. Pure helper, select snapshot,
    compact band bytes, and pricing must all preserve it verbatim.

    Kills mutants that disable either pass-through guard (always recompose in
    labeled_or_recomposed_turn_rendering or always rewrite in select).
    """
    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    for i in range(5):
        captured = await sdk.intake_stream.message_events(
            {"filePath": file_path},
            [
                valid_event("user_prompt", {"payload": {"text": f"seed {i}"}}),
                valid_event("assistant_text", {"payload": {"text": f"reply {i}"}}),
                valid_event("turn_end"),
            ],
        )
        assert captured.ok
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok

    # Seed every ready turn_rendering with a distinctive labeled body.
    distinctive_by_id: dict[str, str] = {}
    db = open_raw(file_path)
    try:
        turn_ids = [
            str(row["subject_id"])
            for row in db.prepare(
                """SELECT subject_id FROM derivation
                   WHERE subject_kind = 'turn'
                     AND derivation_type = 'turn_rendering'
                     AND state = 'ready'"""
            ).all()
        ]
        assert len(turn_ids) >= 1
        for turn_id in turn_ids:
            body = _distinctive_labeled_body(turn_id)
            assert stored_rendering_has_turn_label(body, turn_id)
            distinctive_by_id[turn_id] = body
            db.prepare(
                """UPDATE derivation SET content = ?
                   WHERE subject_kind = 'turn' AND subject_id = ?
                     AND derivation_type = 'turn_rendering'"""
            ).run(body, turn_id)

        # Canonical recompose of t1 must differ in bytes and tokens (precondition).
        members = read_member_messages(db, "t1")
        derivations = read_message_derivation_rows(
            db, [message.message_id for message in members]
        )
        canonical = compose_structured_turn_text(
            compose_rendering_input(members, derivations).parts, "t1"
        )
        distinctive = distinctive_by_id["t1"]
        assert distinctive != canonical
        assert estimate_tokens(distinctive) != estimate_tokens(canonical)

        # (1) Pure helper: labeled stored passes through even when recompose differs.
        assert (
            labeled_or_recomposed_turn_rendering(
                "t1", distinctive, members, derivations
            )
            == distinctive
        )
        # Disabling pass-through would yield canonical instead.
        assert (
            labeled_or_recomposed_turn_rendering(
                "t1", distinctive, members, derivations
            )
            != canonical
        )

        # (2) Select snapshot rewrite must keep distinctive (not recompose).
        inputs = read_selection_inputs(db)
        for turn_id, body in distinctive_by_id.items():
            snap = inputs.derivations[f"{turn_id}/turn_rendering"]
            assert snap.content == body
            assert snap.content.count(f"<{turn_id}>") == 1
            assert estimate_tokens(snap.content or "") == estimate_tokens(body)

        def lookup(subject_id: str, derivation_type: str):
            return inputs.derivations.get(f"{subject_id}/{derivation_type}")

        rep = resolve_smooth_representation("t1", lookup, None)
        entry_text = render_arrangement_entry("turn", "t1", rep, [])
        assert entry_text == distinctive
        assert estimate_tokens(entry_text) == estimate_tokens(distinctive)
        assert "PASS_THROUGH_MARKER_NOT_FROM_CANONICAL_RECOMPOSE" in entry_text
        assert "seed 0" not in entry_text  # would appear under always-recompose
    finally:
        db.close()

    # (3) Compact band bytes + pricing preserve distinctive labeled bodies.
    compacted = await sdk.thread_view.compact(
        {"filePath": file_path},
        CompactOpts(
            params=ViewCompactParams(
                lower_bound=40,
                percentages=PartialViewProfilePercentages(
                    full=25, smooth=75, detailed=0, brief=0
                ),
            )
        ),
    )
    assert compacted.ok, getattr(compacted, "error", None)
    db = open_raw(file_path)
    try:
        row = db.prepare(
            "SELECT rendered_text FROM thread_view_band WHERE band = 'smooth'"
        ).get()
    finally:
        db.close()
    assert row is not None
    band_text = str(row["rendered_text"])
    assert "PASS_THROUGH_MARKER_NOT_FROM_CANONICAL_RECOMPOSE" in band_text
    for turn_num in set(re.findall(r"<t(\d+)>", band_text)):
        turn_id = f"t{turn_num}"
        assert distinctive_by_id[turn_id] in band_text
        assert band_text.count(f"<{turn_id}>") == 1
        # Canonical seed text must not replace the distinctive marker body.
        assert f"PASS_THROUGH_MARKER_NOT_FROM_CANONICAL_RECOMPOSE_{turn_id}" in band_text
    assert compacted.value.bands["smooth"].tokens == estimate_tokens(band_text)


@pytest.mark.asyncio
async def test_legacy_recompose_excludes_publicly_deleted_member_with_independent_oracle(
    store: TempStore,
) -> None:
    """Legacy fallback recomposes from live members only: deleted content out,
    surviving source/block order and ready message derivation content in.

    Oracle is pure compose from known survivors + smoothed derivation content
    from messages.list — not read_member_messages / production recompose reader.
    """
    keep_prompt = "KEEP_UNIQUE_BODY_aaa"
    delete_text = "DELETE_UNIQUE_BODY_zzz"
    survive_text = "SURVIVE_UNIQUE_BODY_bbb"

    sdk = _manual_sdk()
    file_path = await _new_thread(sdk, store)
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt", {"payload": {"text": keep_prompt}}),
            valid_event("assistant_text", {"payload": {"text": delete_text}}),
            valid_event("assistant_text", {"payload": {"text": survive_text}}),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok
    drained = await sdk.work.drain({"filePath": file_path})
    assert drained.ok

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok
    assert [m.message_id for m in listed.value] == ["m1", "m2", "m3"]
    m1 = next(m for m in listed.value if m.message_id == "m1")
    smoothed = next(
        d.content
        for d in (m1.derivations or [])
        if d.derivation_type == "smoothed_prompt" and d.content is not None
    )
    assert keep_prompt.split("_")[0] in smoothed or "smoothed" in smoothed

    # Public domain delete of the uniquely identifiable middle member.
    removed = await sdk.messages.remove(
        {"filePath": file_path}, RemoveInput(message_id="m2")
    )
    assert removed.ok, getattr(removed, "error", None)

    # Independent oracle: survivors only, contract order m1 then m3, ready
    # smoothed_prompt content from the list surface (not production member reader).
    independent_members = [
        ComposeMessage(
            message_id="m1",
            kind="user_prompt",
            blocks=[ComposeBlock(block_type="user_prompt", content={"text": keep_prompt})],
        ),
        ComposeMessage(
            message_id="m3",
            kind="assistant_text",
            blocks=[
                ComposeBlock(block_type="assistant_text", content={"text": survive_text})
            ],
        ),
    ]
    independent_derivations = {
        compose_derivation_key("m1", "smoothed_prompt"): ComposeDerivationRow(
            state="ready",
            source_version=1,
            content=smoothed,
        )
    }
    independent_expected = compose_structured_turn_text(
        compose_rendering_input(independent_members, independent_derivations).parts,
        "t1",
    )
    assert delete_text not in independent_expected
    assert f"<m1>\n{smoothed}\n</m1>" in independent_expected
    assert f"<m3>\n{survive_text}\n</m3>" in independent_expected
    assert independent_expected.index("<m1>") < independent_expected.index("<m3>")
    assert "<m2>" not in independent_expected

    # Delete cascades clear turn_rendering; re-seed ready legacy unlabeled row
    # (same class of DB mutation other R3 tests use) so the serve-time fallback runs.
    db = open_raw(file_path)
    try:
        db.prepare(
            """UPDATE derivation
               SET state = 'ready', content = 'legacy untagged rendering', reason = NULL
               WHERE subject_kind = 'turn' AND subject_id = 't1'
                 AND derivation_type = 'turn_rendering'"""
        ).run()
        # Confirm tombstone on m2 without using production member reader as oracle.
        row = db.prepare(
            "SELECT deleted_at FROM message WHERE message_id = 'm2'"
        ).get()
        assert row is not None and row["deleted_at"] is not None
    finally:
        db.close()

    # Pure helper with independent survivor inputs (no production reader).
    pure = labeled_or_recomposed_turn_rendering(
        "t1",
        "legacy untagged rendering",
        independent_members,
        independent_derivations,
    )
    assert pure == independent_expected

    # Production select path must match the independent oracle.
    db = open_raw(file_path)
    try:
        inputs = read_selection_inputs(db)
        got = inputs.derivations["t1/turn_rendering"].content
        assert got == independent_expected
        assert delete_text not in (got or "")
        assert survive_text in (got or "")
        assert smoothed in (got or "")
        assert "<m2>" not in (got or "")
        assert estimate_tokens(got or "") == estimate_tokens(independent_expected)

        def lookup(subject_id: str, derivation_type: str):
            return inputs.derivations.get(f"{subject_id}/{derivation_type}")

        rep = resolve_smooth_representation("t1", lookup, None)
        entry_text = render_arrangement_entry("turn", "t1", rep, [])
        assert entry_text == independent_expected
        assert estimate_tokens(entry_text) == estimate_tokens(independent_expected)
    finally:
        db.close()
