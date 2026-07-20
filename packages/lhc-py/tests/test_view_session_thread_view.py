"""Ported from packages/lhc/test/view-session-thread-view.test.ts. Phase 1."""

from __future__ import annotations

import asyncio
import re

import pytest

from lhc import Lhc, create_deterministic_inference_callbacks, init_lhc
from lhc.shared_tech.derivation import SdkConfig
from lhc.shared_tech.view import (
    PartialVisibilityBudgets,
    SdkViewConfig,
    SessionAssistantMessage,
    SessionThreadViewEntry,
    SessionThreadViewMessage,
    SessionToolResultMessage,
    SessionUserMessage,
)
from fixtures import (
    TempStore,
    boundary_tokens,
    conversation_turn,
    event_batch,
    seed_view_boundary,
    temp_store,
    valid_event,
)


@pytest.fixture
def store():
    s = temp_store()
    yield s
    s.cleanup()


@pytest.fixture
async def sdk_and_path(store: TempStore):
    sdk = init_lhc(
        SdkConfig(mode="manual", inference_callbacks=create_deterministic_inference_callbacks())
    )
    path = store.thread_path()
    created = await sdk.threads.new_thread(
        {"filePath": path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)
    return sdk, path


def _is_message_entry(entry: SessionThreadViewEntry) -> bool:
    return hasattr(entry, "role")


def _message_entries(entries: list[SessionThreadViewEntry]) -> list[SessionThreadViewMessage]:
    return [e for e in entries if _is_message_entry(e)]  # type: ignore[misc]


def _message_roles(entries: list[SessionThreadViewEntry]) -> list[str]:
    return [e.role for e in _message_entries(entries)]  # type: ignore[union-attr]


def _entry_kinds(entries: list[SessionThreadViewEntry]) -> list[str]:
    return [
        (entry.kind if hasattr(entry, "kind") else entry.role)  # type: ignore[union-attr]
        for entry in entries
    ]


def _idempotency_key_pattern() -> re.Pattern[str]:
    return re.compile(r"^fixture-key-\d+$")


def _assert_source(source, message_id: str) -> None:
    assert source.message_id == message_id
    assert source.idempotency_key is not None
    assert _idempotency_key_pattern().match(source.idempotency_key)


async def test_returns_user_and_assistant_messages_for_a_simple_turn(sdk_and_path) -> None:
    """returns user and assistant messages for a simple turn"""
    sdk, file_path = sdk_and_path
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path}, event_batch(["user_prompt", "assistant_text"])
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return

    msgs = _message_entries(view.value.entries)
    assert len(msgs) == 2
    user = msgs[0]
    assert user.role == "user"
    assert user.content == "please read the file"
    assert len(user.source_messages) == 1
    _assert_source(user.source_messages[0], "m1")
    assistant = msgs[1]
    assert assistant.role == "assistant"
    assert len(assistant.content) == 1
    assert assistant.content[0].type == "text"
    assert assistant.content[0].text == "here is what I found"
    assert len(assistant.source_messages) == 1
    _assert_source(assistant.source_messages[0], "m2")


async def test_groups_assistant_thinking_text_and_tool_calls_into_one_assistant_message(
    sdk_and_path,
) -> None:
    """groups assistant thinking, text, and tool calls into one assistant message"""
    sdk, file_path = sdk_and_path
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        event_batch(["user_prompt", "assistant_thinking", "assistant_text", "tool_call"]),
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return

    assert _message_roles(view.value.entries) == ["user", "assistant"]
    assistant = _message_entries(view.value.entries)[1]
    assert isinstance(assistant, SessionAssistantMessage)
    assert [part.type for part in assistant.content] == ["thinking", "text", "toolCall"]
    # TS toMatchObject — named fields only
    part = assistant.content[2]
    assert part.type == "toolCall"
    assert part.tool_call_id == "call-1"
    assert part.tool_name == "read_file"
    assert part.arguments == {"path": "notes.txt"}
    assert len(assistant.source_messages) == 3
    _assert_source(assistant.source_messages[0], "m2")
    _assert_source(assistant.source_messages[1], "m3")
    _assert_source(assistant.source_messages[2], "m4")


async def test_emits_tool_result_after_the_assistant_message_and_starts_a_new_assistant(
    sdk_and_path,
) -> None:
    """emits toolResult after the assistant message and starts a new assistant after tool results"""
    sdk, file_path = sdk_and_path
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        event_batch(
            ["user_prompt", "assistant_thinking", "tool_call", "tool_result", "assistant_text", "turn_end"]
        ),
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return

    assert _message_roles(view.value.entries) == ["user", "assistant", "toolResult", "assistant"]
    tool_result = _message_entries(view.value.entries)[2]
    # TS toMatchObject — named fields only (extras allowed)
    assert tool_result.role == "toolResult"
    assert tool_result.tool_call_id == "call-1"
    assert tool_result.content == "contents of notes.txt"


async def test_covers_a_full_conversation_turn_with_native_session_shapes(sdk_and_path) -> None:
    """covers a full conversation turn with native session shapes"""
    sdk, file_path = sdk_and_path
    captured = await sdk.intake_stream.message_events({"filePath": file_path}, conversation_turn())
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return

    assert _message_roles(view.value.entries) == ["user", "assistant", "toolResult"]


async def test_emits_model_change_and_thinking_level_change_entries_for_runtime_changes(
    sdk_and_path,
) -> None:
    """emits model_change and thinking_level_change entries for runtime changes"""
    sdk, file_path = sdk_and_path
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event(
                "model_change",
                {"payload": {"previousModel": "anthropic/claude-3", "newModel": "openai/gpt-4o"}},
            ),
            valid_event(
                "thinking_level_change",
                {"payload": {"previousLevel": "low", "newLevel": "high"}},
            ),
            valid_event("assistant_text"),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return

    assert _entry_kinds(view.value.entries) == [
        "user",
        "model_change",
        "thinking_level_change",
        "assistant",
    ]
    entry1 = view.value.entries[1]
    assert getattr(entry1, "kind", None) == "model_change"
    assert entry1.provider == "openai"  # type: ignore[union-attr]
    assert entry1.model_id == "gpt-4o"  # type: ignore[union-attr]
    _assert_source(entry1.source_messages[0], "m2")  # type: ignore[union-attr]
    entry2 = view.value.entries[2]
    assert getattr(entry2, "kind", None) == "thinking_level_change"
    assert entry2.level == "high"  # type: ignore[union-attr]
    _assert_source(entry2.source_messages[0], "m3")  # type: ignore[union-attr]


async def test_serves_full_tool_result_content_before_compact_even_when_zone_exceeds_max(
    store: TempStore,
) -> None:
    """serves full tool-result content before compact even when the zone exceeds visibility max"""
    sdk_with_budgets = init_lhc(
        SdkConfig(
            mode="manual",
            inference_callbacks=create_deterministic_inference_callbacks(),
            view=SdkViewConfig(
                visibility=PartialVisibilityBudgets(max_tokens=10, target_tokens=5)
            ),
        )
    )
    path = store.thread_path()
    created = await sdk_with_budgets.threads.new_thread(
        {"filePath": path, "registryPath": store.registry_path}
    )
    if not created.ok:
        raise RuntimeError(created.error.reason)

    large_result = boundary_tokens(40)
    captured = await sdk_with_budgets.intake_stream.message_events(
        {"filePath": path},
        [
            valid_event("user_prompt", {"payload": {"text": "read a large file"}}),
            valid_event(
                "tool_call",
                {
                    "payload": {
                        "toolCallId": "call-large",
                        "toolName": "read_file",
                        "arguments": {"path": "big.txt"},
                    }
                },
            ),
            valid_event(
                "tool_result",
                {
                    "payload": {
                        "toolCallId": "call-large",
                        "content": large_result,
                        "isError": False,
                    }
                },
            ),
            valid_event("turn_end"),
        ],
    )
    assert captured.ok is True

    view = await sdk_with_budgets.thread_view.get_session_thread_view({"filePath": path})
    assert view.ok is True
    if not view.ok:
        return

    tool_result = next(
        (e for e in _message_entries(view.value.entries) if e.role == "toolResult"),
        None,
    )
    # TS toMatchObject — named fields only (extras allowed)
    assert tool_result is not None
    assert tool_result.role == "toolResult"
    assert tool_result.tool_call_id == "call-large"
    assert tool_result.content == large_result
    assert "abridged" not in tool_result.content


async def test_shortens_at_or_behind_boundary_tool_results_like_get_llm_request_context(
    sdk_and_path,
) -> None:
    """shortens at-or-behind-boundary tool results like getLlmRequestContext"""
    sdk, file_path = sdk_and_path
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        event_batch(["user_prompt", "tool_call", "tool_result", "assistant_text", "turn_end"]),
    )
    assert captured.ok is True

    listed = await sdk.messages.list({"filePath": file_path})
    assert listed.ok is True
    if not listed.ok:
        return
    result = next((m for m in listed.value if m.kind == "tool_result"), None)
    assert result is not None
    if result is None:
        return

    seed_view_boundary(file_path, result.source_event_order)

    session_view, llm_context = await asyncio.gather(
        sdk.thread_view.get_session_thread_view({"filePath": file_path}),
        sdk.thread_view.get_llm_request_context({"filePath": file_path}),
    )
    assert session_view.ok is True
    assert llm_context.ok is True
    if not session_view.ok or not llm_context.ok:
        return

    session_tool_result = next(
        (e for e in _message_entries(session_view.value.entries) if e.role == "toolResult"),
        None,
    )
    assert isinstance(session_tool_result, SessionToolResultMessage)

    llm_tool_result = next(
        (
            m
            for m in llm_context.value.messages
            if m.content and m.content[0].text.startswith("[tool result · read_file")
        ),
        None,
    )
    assert llm_tool_result is not None
    if llm_tool_result is None:
        return

    llm_text = llm_tool_result.content[0].text
    llm_body = re.sub(r"^\[tool result · [^\]]+\]\n", "", llm_text)
    assert session_tool_result.content == llm_body


async def test_renders_runtime_notes_as_labeled_user_entries_in_tail_order(sdk_and_path) -> None:
    """renders runtime notes as labeled user entries in tail order"""
    sdk, file_path = sdk_and_path
    note_text = "<task-notification>task t-123 completed: build finished</task-notification>"
    captured = await sdk.intake_stream.message_events(
        {"filePath": file_path},
        [
            valid_event("user_prompt"),
            valid_event("assistant_text"),
            valid_event("runtime_note", {"payload": {"text": note_text}}),
            valid_event("assistant_text", {"payload": {"text": "picked up the notification"}}),
        ],
    )
    assert captured.ok is True

    view = await sdk.thread_view.get_session_thread_view({"filePath": file_path})
    assert view.ok is True
    if not view.ok:
        return

    assert _message_roles(view.value.entries) == ["user", "assistant", "user", "assistant"]
    note = _message_entries(view.value.entries)[2]
    assert isinstance(note, SessionUserMessage)
    assert note.content == f"[runtime note] {note_text}"
    assert len(note.source_messages) == 1
