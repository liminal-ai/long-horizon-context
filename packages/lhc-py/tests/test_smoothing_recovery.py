"""Ported from packages/lhc/test/smoothing-recovery.test.ts. Phase 1."""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from lhc import (
    InferenceCallbacks,
    Lhc,
    MessageEventInput,
    count_live_items,
    init_lhc,
    messages,
    threads,
)
from lhc.shared_tech.derivation import InferenceOk, LeaseConfig, SdkConfig
from lhc.shared_tech.deterministic import deterministic_text
from lhc.shared_tech.inference_types import DerivationGuards, SmoothedPromptGuards
from lhc.shared_tech.token_counting import estimate_tokens
from lhc.shared_tech.work_queue import WorkSourceRefMessage
from lhc.intake_stream import QueuedWorkItem
from lhc.threads import NewThreadInput
from fixtures import (
    TempStore,
    create_inference_callbacks_double,
    open_raw,
    read_derived_forms,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


async def _new_thread(store: TempStore) -> str:
    created = await threads.new_thread(
        NewThreadInput(file_path=store.thread_path(), registry_path=store.registry_path)
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return created.value.file_path


def _sdk_for(
    inference_callbacks: InferenceCallbacks,
    *,
    guards: DerivationGuards | None = None,
) -> Lhc:
    return init_lhc(
        SdkConfig(
            inference_callbacks=inference_callbacks,
            mode="manual",
            lease=LeaseConfig(duration_ms=200),
            guards=guards,
        )
    )


async def _send(sdk: Lhc, file_path: str, batch: Sequence[MessageEventInput]) -> None:
    result = await sdk.intake_stream.message_events({"filePath": file_path}, batch)
    if not result.ok:
        raise RuntimeError(result.error.reason)


async def _drain(sdk: Lhc, file_path: str, opts: dict | None = None):
    result = await sdk.work.drain({"filePath": file_path}, opts)
    if not result.ok:
        raise RuntimeError(result.error.reason)
    return result.value


def _form_of(file_path: str, subject_id: str, derivation_type: str):
    return next(
        (
            form
            for form in read_derived_forms(file_path)
            if form.subject_id == subject_id and form.derivation_type == derivation_type
        ),
        None,
    )


def _delete_work_item(file_path: str, work_item_id: str) -> None:
    db = open_raw(file_path)
    try:
        db.prepare("DELETE FROM work_item WHERE work_item_id = ?").run(work_item_id)
    finally:
        db.close()


async def test_cleans_every_prompt_before_inference_and_invokes_smoothprompt_only_under_the_cap(
    store: TempStore,
) -> None:
    """cleans every prompt before inference and invokes smoothPrompt only under the cap"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    text = "  please\t\t smooth\n\n\n this   prompt because i need it  "
    cleaned = "please smooth\n\nthis prompt because I need it"

    await _send(sdk, file_path, [valid_event("user_prompt", {"payload": {"text": text}})])
    await _drain(sdk, file_path)

    assert [(c.op, c.input) for c in captured] == [("smoothPrompt", {"text": cleaned})]
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == deterministic_text("smoothPrompt", {"text": cleaned}, cleaned)


async def test_skips_inference_over_the_cap_but_still_stores_the_deterministic_floor_as_ready(
    store: TempStore,
) -> None:
    """skips inference over the cap but still stores the deterministic floor as ready"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(
        double, guards=DerivationGuards(smoothed_prompt=SmoothedPromptGuards(max_inference_tokens=1))
    )
    file_path = await _new_thread(store)
    fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```"
    text = f"  hello    world  \n{fenced}\n  because i asked  " * 8
    cleaned = messages.clean_prompt(text)

    await _send(sdk, file_path, [valid_event("user_prompt", {"payload": {"text": text}})])
    await _drain(sdk, file_path)

    assert captured == []
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == cleaned
    assert form.content is not None
    assert fenced in form.content


async def test_keeps_the_cap_boundary_strict_equal_runs_inference_above_skips(
    store: TempStore,
) -> None:
    """keeps the cap boundary strict: equal runs inference, above skips"""
    equal_double = create_inference_callbacks_double()
    equal_captured = equal_double.capture_inputs()
    over_double = create_inference_callbacks_double()
    over_captured = over_double.capture_inputs()
    text = "one two three four five six seven eight nine ten"
    token_count = estimate_tokens(text)

    equal_sdk = _sdk_for(
        equal_double,
        guards=DerivationGuards(
            smoothed_prompt=SmoothedPromptGuards(max_inference_tokens=token_count)
        ),
    )
    equal_file = await _new_thread(store)
    await _send(equal_sdk, equal_file, [valid_event("user_prompt", {"payload": {"text": text}})])
    await _drain(equal_sdk, equal_file)

    over_sdk = _sdk_for(
        over_double,
        guards=DerivationGuards(
            smoothed_prompt=SmoothedPromptGuards(max_inference_tokens=token_count - 1)
        ),
    )
    over_file = await _new_thread(store)
    await _send(over_sdk, over_file, [valid_event("user_prompt", {"payload": {"text": text}})])
    await _drain(over_sdk, over_file)

    assert [entry.op for entry in equal_captured] == ["smoothPrompt"]
    assert over_captured == []


async def test_does_not_call_inference_callbacks_during_intake_intake_only_queues_smoothing_work(
    store: TempStore,
) -> None:
    """does not call inference callbacks during intake; intake only queues smoothing work"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)

    result = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [valid_event("user_prompt", {"payload": {"text": "please smooth later"}})],
    )

    assert result.ok is True
    if not result.ok:
        return
    assert captured == []
    assert result.value.queued_work == [
        QueuedWorkItem(
            work_item_id="w-m1-prompt_smoothing-v1",
            owner="messages",
            kind="prompt_smoothing",
            source_ref=WorkSourceRefMessage(messageId="m1"),
        )
    ]


async def test_preserves_fenced_code_through_the_inference_path_while_cleaning_prose(
    store: TempStore,
) -> None:
    """preserves fenced code through the inference path while cleaning prose"""
    double = create_inference_callbacks_double()
    fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```"
    prompt_text = f"plz\t\t fix this\n{fenced}\nthx"
    inference_callback_input: list[str | None] = [None]

    class _Callbacks:
        async def smooth_prompt(self, i):
            inference_callback_input[0] = i["text"] if isinstance(i, dict) else getattr(i, "text", None)
            return InferenceOk(text=f"Please fix this.\n{fenced}\nThanks.")

        async def summarize_tool_result(self, i):
            return await double.summarize_tool_result(i)

        async def compress_detailed_turn(self, i):
            return await double.compress_detailed_turn(i)

        async def summarize_chunk_brief(self, i):
            return await double.summarize_chunk_brief(i)

    callbacks: InferenceCallbacks = _Callbacks()
    sdk = _sdk_for(callbacks)
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [valid_event("user_prompt", {"payload": {"text": prompt_text}})],
    )
    await _drain(sdk, file_path)

    assert inference_callback_input[0] == f"plz fix this\n{fenced}\nthx"
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.content == f"Please fix this.\n{fenced}\nThanks."


async def test_pending_smoothing_uses_a_composition_floor_without_re_running_message_inference(
    store: TempStore,
) -> None:
    """pending smoothing uses a composition floor without re-running message inference"""
    double = create_inference_callbacks_double()
    captured = double.capture_inputs()
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    text = "  raw     prompt because i asked  "
    floor = "raw prompt because I asked"

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": text}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    _delete_work_item(file_path, "w-m1-prompt_smoothing-v1")
    await _drain(sdk, file_path)

    rendering = _form_of(file_path, "t1", "turn_rendering")
    assert rendering is not None
    assert rendering.content is not None
    assert floor in rendering.content
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    assert form.content == floor
    assert rendering.state == "ready"
    assert [entry for entry in captured if entry.op == "smoothPrompt"] == []


async def test_smoothing_failure_lands_failed_with_reason_then_turn_composition_consumes_the_floor(
    store: TempStore,
) -> None:
    """smoothing failure lands failed with reason, then turn composition consumes the floor"""
    double = create_inference_callbacks_double()
    double.fail_kind("prompt_smoothing", 99, {"reason": "scripted failure"})
    sdk = _sdk_for(double)
    file_path = await _new_thread(store)
    text = "  failed     prompt because i asked  "
    floor = "failed prompt because I asked"

    await _send(
        sdk,
        file_path,
        [
            valid_event("user_prompt", {"payload": {"text": text}}),
            valid_event("assistant_text", {"payload": {"text": "answer"}}),
            valid_event("turn_end"),
        ],
    )
    report = await _drain(sdk, file_path)

    assert any(
        entry.work_item_id == "w-m1-prompt_smoothing-v1"
        and entry.disposition == "failed_terminal"
        and entry.reason == "scripted failure"
        for entry in report.ran
    )
    form = _form_of(file_path, "m1", "smoothed_prompt")
    assert form is not None
    assert form.state == "ready"
    rendering = _form_of(file_path, "t1", "turn_rendering")
    assert rendering is not None
    assert rendering.content is not None
    assert floor in rendering.content
    assert rendering.state == "ready"


def test_cleanprompt_is_pure_for_deterministic_recovery_floors() -> None:
    """cleanPrompt is pure for deterministic recovery floors"""
    input_text = "  please\tfix this because i need it\n\n\nnow  "
    assert messages.clean_prompt(input_text) == "please fix this because I need it\n\nnow"
    assert messages.clean_prompt(input_text) == messages.clean_prompt(input_text)
    fenced = "```ts\n\tconst  i = 1;\n\n\t\treturn  i;\n```"
    assert messages.clean_prompt(f"  please\tfix\n{fenced}\n because i asked  ") == (
        f"please fix\n{fenced}\nbecause I asked"
    )


async def test_over_cap_deterministic_smoothing_leaves_no_live_queue_items(
    store: TempStore,
) -> None:
    """over-cap deterministic smoothing leaves no live queue items"""
    double = create_inference_callbacks_double()
    sdk = _sdk_for(
        double, guards=DerivationGuards(smoothed_prompt=SmoothedPromptGuards(max_inference_tokens=1))
    )
    file_path = await _new_thread(store)

    await _send(
        sdk,
        file_path,
        [valid_event("user_prompt", {"payload": {"text": "hello world " * 50}})],
    )
    await _drain(sdk, file_path)

    db = open_raw(file_path)
    try:
        assert count_live_items(db) == 0
    finally:
        db.close()
