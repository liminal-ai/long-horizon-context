"""Ported from packages/lhc/src/thread-view/internal/session-view.ts.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace

from ...shared_tech.storage import Database
from ...shared_tech.view import (
    Band,
    SessionAssistantMessage,
    SessionAssistantPart,
    SessionModelChangeEntry,
    SessionThinkingLevelChangeEntry,
    SessionThreadView,
    SessionThreadViewEntry,
    SessionThreadViewEntrySource,
    SessionToolResultMessage,
    SessionUserMessage,
    SessionUserSteerSource,
)
from ...shared_tech.user_steer import USER_STEER_PAYLOAD_VERSION
from .boundary import read_boundary_position
from .render import (
    TailRenderContext,
    is_empty_thinking_husk,
    tool_names_by_call_id,
    tool_result_session_content,
)
from .snapshot import (
    TailMessageRow,
    read_tail_messages,
    read_thread_metadata,
    read_view_snapshot,
)
from .select import CanonicalCorruptionError


def _block_content(message: TailMessageRow) -> dict[str, object]:
    # TS: message.blocks[0]?.content ?? {}
    if len(message.blocks) == 0:
        return {}
    content = message.blocks[0].content
    return {} if content is None else content


def _text_of(message: TailMessageRow) -> str:
    text = _block_content(message).get("text")
    return text if isinstance(text, str) else ""


def _entry_source(message: TailMessageRow) -> SessionThreadViewEntrySource:
    return SessionThreadViewEntrySource(
        message_id=message.message_id,
        idempotency_key=message.idempotency_key,
    )


def _steer_source_of(message: TailMessageRow) -> SessionUserSteerSource:
    content = _block_content(message)
    version = content.get("version")
    steer_id = content.get("steerId")
    if version != USER_STEER_PAYLOAD_VERSION or not isinstance(steer_id, str) or steer_id == "":
        raise CanonicalCorruptionError(
            "source_damaged",
            f"canonical record corrupt: user_steer message {message.message_id} stores version {version!r} "
            f"and steerId {steer_id!r}; the session source descriptor requires version 1 and a non-empty steerId",
        )
    return SessionUserSteerSource(version=USER_STEER_PAYLOAD_VERSION, steer_id=steer_id)


@dataclass(frozen=True, slots=True)
class _ParsedModelRef:
    provider: str
    model_id: str


def _parse_model_ref(model: str) -> _ParsedModelRef | None:
    slash = model.find("/")
    if slash <= 0 or slash == len(model) - 1:
        return None
    return _ParsedModelRef(provider=model[:slash], model_id=model[slash + 1 :])


def _band_user_message(band: Band, rendered_text: str) -> SessionThreadViewEntry:
    return SessionUserMessage(
        content=f"[context · {band}]\n{rendered_text}",
        source_messages=[],
    )


def _thinking_signature_of(message: TailMessageRow) -> str | None:
    content = _block_content(message)
    signature = content.get("signature")
    if signature is None:
        signature = content.get("thinkingSignature")
    return signature if isinstance(signature, str) and signature != "" else None


def _string_field(content: dict[str, object], key: str) -> str | None:
    value = content.get(key)
    return value if isinstance(value, str) and value != "" else None


@dataclass(frozen=True, slots=True)
class _RowProvenance:
    provider: str | None = None
    model: str | None = None
    api: str | None = None


def _row_provenance_of(row: TailMessageRow) -> _RowProvenance:
    """Provider/model/api carried by one assistant row (thinking or text only)."""
    if row.kind not in ("assistant_thinking", "assistant_text"):
        return _RowProvenance()
    content = _block_content(row)
    return _RowProvenance(
        provider=_string_field(content, "provider"),
        model=_string_field(content, "model"),
        api=_string_field(content, "api"),
    )


def _provenance_conflicts(a: _RowProvenance, b: _RowProvenance) -> bool:
    """True when both sides state a field and disagree — rows with no provenance
    never conflict (they inherit the group's)."""
    return (
        (
            a.provider is not None
            and b.provider is not None
            and a.provider != b.provider
        )
        or (a.model is not None and b.model is not None and a.model != b.model)
        or (a.api is not None and b.api is not None and a.api != b.api)
    )


def _model_provenance_of(rows: Sequence[TailMessageRow]) -> _RowProvenance:
    """First non-empty provider/model/api from grouped assistant rows (thinking or text)."""
    provider: str | None = None
    model: str | None = None
    api: str | None = None
    for row in rows:
        if row.kind not in ("assistant_thinking", "assistant_text"):
            continue
        content = _block_content(row)
        if provider is None:
            provider = _string_field(content, "provider")
        if model is None:
            model = _string_field(content, "model")
        if api is None:
            api = _string_field(content, "api")
        if provider is not None and model is not None and api is not None:
            break
    return _RowProvenance(provider=provider, model=model, api=api)


def _assistant_part_of(message: TailMessageRow) -> SessionAssistantPart:
    kind = message.kind
    if kind == "assistant_thinking":
        part = SessionAssistantPart(type="thinking", thinking=_text_of(message))
        signature = _thinking_signature_of(message)
        if signature is not None:
            return replace(part, thinking_signature=signature)
        return part
    if kind == "assistant_text":
        return SessionAssistantPart(type="text", text=_text_of(message))
    if kind == "tool_call":
        block = _block_content(message)
        tool_call_id = block.get("toolCallId")
        tool_name = block.get("toolName")
        arguments = block.get("arguments")
        return SessionAssistantPart(
            type="toolCall",
            tool_call_id=tool_call_id if isinstance(tool_call_id, str) else "",
            tool_name=tool_name if isinstance(tool_name, str) else "unknown_tool",
            arguments=(
                arguments
                if isinstance(arguments, dict) and not isinstance(arguments, list)
                else {}
            ),
        )
    return SessionAssistantPart(type="text", text="")


def _tool_result_of(message: TailMessageRow, ctx: TailRenderContext) -> SessionThreadViewEntry:
    block = _block_content(message)
    tool_call_id_raw = block.get("toolCallId")
    tool_call_id = tool_call_id_raw if isinstance(tool_call_id_raw, str) else ""
    # TS: ctx.toolNameByCallId.get(toolCallId) ?? "unknown_tool"
    mapped = ctx.tool_name_by_call_id.get(tool_call_id)
    tool_name = "unknown_tool" if mapped is None else mapped
    result = SessionToolResultMessage(
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        content=tool_result_session_content(message, ctx),
        source_messages=[_entry_source(message)],
    )
    if block.get("isError") is True:
        return replace(result, is_error=True)
    return result


def _model_change_of(message: TailMessageRow) -> SessionThreadViewEntry | None:
    block = _block_content(message)
    new_model_raw = block.get("newModel")
    new_model = new_model_raw if isinstance(new_model_raw, str) else ""
    parsed = _parse_model_ref(new_model)
    if parsed is None:
        return None
    return SessionModelChangeEntry(
        provider=parsed.provider,
        model_id=parsed.model_id,
        source_messages=[_entry_source(message)],
    )


def _thinking_level_change_of(message: TailMessageRow) -> SessionThreadViewEntry:
    block = _block_content(message)
    level_raw = block.get("newLevel")
    level = level_raw if isinstance(level_raw, str) else ""
    return SessionThinkingLevelChangeEntry(
        level=level,
        source_messages=[_entry_source(message)],
    )


def _tail_entries_of(rows: Sequence[TailMessageRow], boundary_position: int) -> list[SessionThreadViewEntry]:
    render_ctx = TailRenderContext(
        boundary_position=boundary_position,
        tool_name_by_call_id=tool_names_by_call_id(rows),
    )
    entries: list[SessionThreadViewEntry] = []
    assistant_parts: list[SessionAssistantPart] = []
    assistant_sources: list[SessionThreadViewEntrySource] = []
    assistant_rows: list[TailMessageRow] = []
    assistant_provenance = _RowProvenance()

    def flush_assistant() -> None:
        nonlocal assistant_parts, assistant_sources, assistant_rows, assistant_provenance
        if len(assistant_parts) == 0:
            assistant_provenance = _RowProvenance()
            return
        provenance = _model_provenance_of(assistant_rows)
        entries.append(
            SessionAssistantMessage(
                content=assistant_parts,
                source_messages=assistant_sources,
                provider=provenance.provider,
                model=provenance.model,
                api=provenance.api,
            )
        )
        assistant_parts = []
        assistant_sources = []
        assistant_rows = []
        assistant_provenance = _RowProvenance()

    for row in rows:
        if is_empty_thinking_husk(row):
            continue
        kind = row.kind
        if kind == "user_prompt":
            flush_assistant()
            entries.append(
                SessionUserMessage(
                    content=_text_of(row),
                    source_messages=[_entry_source(row)],
                )
            )
        elif kind == "user_steer":
            flush_assistant()
            entries.append(
                SessionUserMessage(
                    content=_text_of(row),
                    source_messages=[_entry_source(row)],
                    source=_steer_source_of(row),
                )
            )
        elif kind in ("assistant_thinking", "assistant_text", "tool_call"):
            # Identity boundary: message-level provenance covers every signature
            # in the group, so rows captured under a different model/provider
            # must start a new assistant entry — otherwise the identity gate
            # would re-emit (or suppress) the wrong ciphertext on resume.
            rp = _row_provenance_of(row)
            if _provenance_conflicts(assistant_provenance, rp):
                flush_assistant()
            assistant_provenance = _RowProvenance(
                provider=assistant_provenance.provider
                if assistant_provenance.provider is not None
                else rp.provider,
                model=assistant_provenance.model
                if assistant_provenance.model is not None
                else rp.model,
                api=assistant_provenance.api
                if assistant_provenance.api is not None
                else rp.api,
            )
            assistant_parts.append(_assistant_part_of(row))
            assistant_sources.append(_entry_source(row))
            assistant_rows.append(row)
        elif kind == "tool_result":
            flush_assistant()
            entries.append(_tool_result_of(row, render_ctx))
        elif kind == "model_change":
            # Flush first: the change marks a boundary in time, so it must not
            # appear BEFORE assistant output that preceded it.
            flush_assistant()
            model_change = _model_change_of(row)
            if model_change is not None:
                entries.append(model_change)
        elif kind == "thinking_level_change":
            flush_assistant()
            entries.append(_thinking_level_change_of(row))
        elif kind == "runtime_note":
            # Same rendering as getLlmRequestContext: a labeled user line. Hosts
            # rebuilding a session file from this view keep the note in place, so
            # the assistant turn that responded to it stays coherent.
            flush_assistant()
            entries.append(
                SessionUserMessage(
                    content=f"[runtime note] {_text_of(row)}",
                    source_messages=[_entry_source(row)],
                )
            )
    flush_assistant()
    return entries


def build_session_thread_view(db: Database) -> SessionThreadView:
    thread_id = read_thread_metadata(db).thread_id
    snapshot = read_view_snapshot(db)
    # TS: snapshot?.compactPoint ?? 0
    compact_point = 0 if snapshot is None else snapshot.compact_point
    boundary_position = read_boundary_position(db)
    tail_rows = read_tail_messages(db, compact_point)

    entries: list[SessionThreadViewEntry] = []
    if snapshot is not None:
        for band in snapshot.bands:
            entries.append(_band_user_message(band.band, band.rendered_text))
    entries.extend(_tail_entries_of(tail_rows, boundary_position))
    return SessionThreadView(thread_id=thread_id, entries=entries)
