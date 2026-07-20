"""Ported from packages/lhc/src/messages/internal/handlers.ts. Phase 1 skeleton.

Message-level derivation handlers share one shape: read the source message,
optionally join its call-id pair, and return derivation content through
HandlerOutcome. The drain's completion transaction does the version-checked
UPDATE-only write, so stale or deleted sources discard here exactly as
everywhere else. Tool-activity outcomes come from outcome.ts, never inference
text, and land in derivation metadata apart from content.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Literal, Union

from ...shared_tech.derivation import (
    HandlerDerivationWrite,
    HandlerBlocked,
    HandlerFailed,
    HandlerOk,
    DerivationMetadata,
    HandlerOutcome,
    HandlerRunContext,
    InferenceErr,
    InferenceRequestMessage,
    ResolvedSdkConfig,
    ToolOutcome,
    WorkHandler,
    WorkItemRef,
)
from ...shared_tech.logging import (
    DerivationLogEntry,
    DerivationLogTarget,
    LogEntry,
    append_derivation_log,
    write_log,
)
from ...shared_tech.persist import DbReadTransaction
from ...shared_tech.tool_result_rendering import truncate_for_fallback
from ...shared_tech.work_queue import WorkKind
from .classify_tool_result import ToolResultClassificationInput, classify_tool_result
from .derivations import MessageSource, find_paired_tool_call, read_message_source
from .outcome import PairedResult, derive_tool_outcome
from .smoothing import clean_prompt
from ...shared_tech.token_counting import estimate_tokens

_FORCE_TOOL_RESULT_SUMMARY_FALLBACK = True

# Harness marker prompts ("[Request interrupted by user]") are machine text:
# smoothing inference returns empty output on them, burning retries for a
# verbatim fallback. A prompt whose entire trimmed content is one short
# bracketed marker stores its cleaned text directly instead.
_MARKER_PROMPT_PATTERN = re.compile(r"^\[[^\]]{1,80}\]$")


# A handler that cannot read its source coherently has found source damage:
# terminal, derivation blocked with the reason (never a retry loop against a
# record that cannot improve). A *deleted* source never reaches this — its
# derivation row is gone and the completion write would discard — so a miss here
# is genuine corruption.
def _source_damaged(reason: str) -> HandlerOutcome:
    return HandlerBlocked(reason=f"source_damaged: {reason}")


@dataclass(frozen=True, slots=True)
class _LoadSourceOk:
    message_id: str
    source: MessageSource
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class _LoadSourceErr:
    outcome: HandlerOutcome
    ok: Literal[False] = False


_LoadSourceResult = Union[_LoadSourceOk, _LoadSourceErr]


# TS: loadSource(..., item: { sourceRef: Record<string, string> }, ...)
# Narrower than WorkItemRef — only sourceRef is required for this helper.
@dataclass(frozen=True, slots=True)
class _LoadSourceItem:
    source_ref: dict[str, str]


def _load_source(
    run: HandlerRunContext,
    item: _LoadSourceItem,
    expected_kind: str,
) -> _LoadSourceResult:
    source_ref = item.source_ref
    message_id = source_ref.get("messageId")
    if not isinstance(message_id, str):
        return _LoadSourceErr(_source_damaged("work item carries no messageId"))
    source = read_message_source(run.open_db(), message_id)
    if source is None:
        return _LoadSourceErr(_source_damaged(f"message {message_id} not found"))
    if source.kind != expected_kind:
        return _LoadSourceErr(
            _source_damaged(
                f"message {message_id} is kind {source.kind}, expected {expected_kind}"
            )
        )
    return _LoadSourceOk(message_id=message_id, source=source)


@dataclass(frozen=True, slots=True)
class SmoothedPromptDerivation:
    write: HandlerDerivationWrite
    warning_log: LogEntry | None = None


def is_marker_prompt(text: str) -> bool:
    return _MARKER_PROMPT_PATTERN.fullmatch(text.strip()) is not None


async def derive_smoothed_prompt(
    run: HandlerRunContext,
    message_id: str,
    text: str,
) -> SmoothedPromptDerivation | InferenceErr:
    cleaned = clean_prompt(text)
    cleaned_tokens = estimate_tokens(cleaned)
    guards = run.config.guards.smoothed_prompt
    if is_marker_prompt(cleaned) or cleaned_tokens > guards.max_inference_tokens:
        return SmoothedPromptDerivation(
            HandlerDerivationWrite(
                subject_kind="message",
                subject_id=message_id,
                derivation_type="smoothed_prompt",
                content=cleaned,
            )
        )
    result = await run.inference_callbacks.smooth_prompt({"text": cleaned})
    if not result.ok:
        return result
    result_tokens = estimate_tokens(result.text)
    if result_tokens < guards.suspicious_output_ratio * cleaned_tokens:
        return SmoothedPromptDerivation(
            write=HandlerDerivationWrite(
                subject_kind="message",
                subject_id=message_id,
                derivation_type="smoothed_prompt",
                content=cleaned,
                metadata=DerivationMetadata(discard_reason="suspicious_output_ratio"),
            ),
            warning_log=LogEntry(
                level="warning",
                message="suspicious smoothed_prompt output discarded",
                derivation_type="smoothed_prompt",
                subject_id=message_id,
                reason="suspicious_output_ratio",
                floor_used=cleaned,
            ),
        )
    return SmoothedPromptDerivation(
        HandlerDerivationWrite(
            subject_kind="message",
            subject_id=message_id,
            derivation_type="smoothed_prompt",
            content=result.text,
            metadata=DerivationMetadata(
                inference_attempted=True,
                inference_succeeded=True,
                provenance=result.provenance,
            ),
        )
    )


async def _smooth_prompt_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    loaded = _load_source(run, item, "user_prompt")  # type: ignore[arg-type]
    if not loaded.ok:
        return loaded.outcome
    text = loaded.source.blocks[0].content.get("text") if loaded.source.blocks else None
    if not isinstance(text, str):
        return _source_damaged(f"prompt {loaded.message_id} has no text block")
    derived = await derive_smoothed_prompt(run, loaded.message_id, text)
    if isinstance(derived, InferenceErr):
        append_derivation_log(
            DbReadTransaction(
                db=run.open_db(), thread_id=run.thread_id, file_path=run.file_path
            ),
            DerivationLogEntry(
                target=DerivationLogTarget(
                    subject_kind="message",
                    subject_id=loaded.message_id,
                    derivation_type="smoothed_prompt",
                ),
                event_kind="inference_failed",
                payload={
                    "reason": derived.reason,
                    **(
                        {"requestMessages": derived.request_messages}
                        if derived.request_messages is not None
                        else {}
                    ),
                },
            ),
        )
        return HandlerFailed(reason=derived.reason)
    on_applied = None
    if derived.warning_log is not None:
        warning_log = derived.warning_log

        def on_applied(transaction: object) -> None:
            transaction.on_commit(  # type: ignore[attr-defined]
                lambda: write_log(
                    DbReadTransaction(
                        db=transaction.db,  # type: ignore[attr-defined]
                        thread_id=run.thread_id,
                        file_path=run.file_path,
                    ),
                    warning_log,
                )
            )

    return HandlerOk(derivations=[derived.write], on_applied=on_applied)


def tool_result_target_tokens(tokens: int, config: ResolvedSdkConfig) -> int:
    tier = config.tool_result
    ratio = (
        tier.small_target_ratio
        if tokens <= tier.small_tier_tokens
        else tier.mid_target_ratio
    )
    return max(1, math.ceil(tokens * ratio))


@dataclass(frozen=True, slots=True)
class ToolResultSummaryInput:
    tool_name: str
    content: str
    outcome: ToolOutcome
    tool_input: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class ToolResultSummaryOpts:
    use_inference: bool | None = None


@dataclass(frozen=True, slots=True)
class ToolResultSummaryDerivation:
    write: HandlerDerivationWrite
    request_messages: list[InferenceRequestMessage] | None = None
    raw_response: str | None = None


async def derive_tool_result_summary(
    run: HandlerRunContext,
    message_id: str,
    input: ToolResultSummaryInput,
    opts: ToolResultSummaryOpts | None = None,
) -> ToolResultSummaryDerivation | InferenceErr:
    tokens = estimate_tokens(input.content)
    use_inference = (
        opts.use_inference
        if opts is not None and opts.use_inference is not None
        else not _FORCE_TOOL_RESULT_SUMMARY_FALLBACK
    )
    if not use_inference:
        return ToolResultSummaryDerivation(
            write=HandlerDerivationWrite(
                subject_kind="message",
                subject_id=message_id,
                derivation_type="tool_result_summary",
                content=truncate_for_fallback(input.content),
                metadata=DerivationMetadata(outcome=input.outcome),
            )
        )
    if tokens <= run.config.tool_result.small_tier_tokens:
        return ToolResultSummaryDerivation(
            write=HandlerDerivationWrite(
                subject_kind="message",
                subject_id=message_id,
                derivation_type="tool_result_summary",
                content=input.content,
                metadata=DerivationMetadata(outcome=input.outcome),
            )
        )

    classification = classify_tool_result(
        ToolResultClassificationInput(
            tool_name=input.tool_name,
            tool_input=input.tool_input,
            raw_output=input.content,
            outcome=input.outcome,
        )
    )
    result = await run.inference_callbacks.summarize_tool_result(
        {
            "toolName": input.tool_name,
            "content": input.content,
            "outcome": input.outcome,
            "targetTokens": tool_result_target_tokens(tokens, run.config),
            "operationClass": classification.operation_class,
            "responseShape": classification.response_shape,
            "promptMode": classification.prompt_mode,
            "facts": classification.facts,
        }
    )
    if isinstance(result, InferenceErr):
        return result
    return ToolResultSummaryDerivation(
        write=HandlerDerivationWrite(
            subject_kind="message",
            subject_id=message_id,
            derivation_type="tool_result_summary",
            content=result.text,
            metadata=DerivationMetadata(
                outcome=input.outcome,
                inference_attempted=True,
                inference_succeeded=True,
                provenance=result.provenance,
            ),
        ),
        request_messages=result.request_messages,
        raw_response=result.raw_response,
    )


async def _tool_result_summary_handler(run: HandlerRunContext, item: WorkItemRef) -> HandlerOutcome:
    loaded = _load_source(run, item, "tool_result")  # type: ignore[arg-type]
    if not loaded.ok:
        return loaded.outcome
    block = loaded.source.blocks[0].content if loaded.source.blocks else {}
    content = block.get("content")
    if not isinstance(content, str):
        return _source_damaged(
            f"tool result {loaded.message_id} has no tool_result block"
        )
    tool_call_id = block.get("toolCallId")
    paired_call = (
        find_paired_tool_call(run.open_db(), tool_call_id)
        if isinstance(tool_call_id, str)
        else None
    )
    tool_outcome = derive_tool_outcome(
        PairedResult(is_error=block.get("isError") is True)
    )
    derived = await derive_tool_result_summary(
        run,
        loaded.message_id,
        ToolResultSummaryInput(
            tool_name=paired_call.tool_name if paired_call is not None else "unknown_tool",
            tool_input=paired_call.tool_input if paired_call is not None else None,
            content=content,
            outcome=tool_outcome,
        ),
    )
    if isinstance(derived, InferenceErr):
        append_derivation_log(
            DbReadTransaction(
                db=run.open_db(), thread_id=run.thread_id, file_path=run.file_path
            ),
            DerivationLogEntry(
                target=DerivationLogTarget(
                    subject_kind="message",
                    subject_id=loaded.message_id,
                    derivation_type="tool_result_summary",
                ),
                event_kind="inference_failed",
                payload={
                    "reason": derived.reason,
                    **(
                        {"requestMessages": derived.request_messages}
                        if derived.request_messages is not None
                        else {}
                    ),
                },
            ),
        )
        return HandlerFailed(reason=derived.reason)

    on_applied = None
    if (
        derived.write.metadata is not None
        and derived.write.metadata.inference_succeeded is True
    ):
        def on_applied(transaction: object) -> None:
            transaction.on_commit(  # type: ignore[attr-defined]
                lambda: append_derivation_log(
                    DbReadTransaction(
                        db=transaction.db,  # type: ignore[attr-defined]
                        thread_id=run.thread_id,
                        file_path=run.file_path,
                    ),
                    DerivationLogEntry(
                        target=DerivationLogTarget(
                            subject_kind="message",
                            subject_id=loaded.message_id,
                            derivation_type="tool_result_summary",
                        ),
                        event_kind="inference_succeeded",
                        payload={
                            **(
                                {"provenance": derived.write.metadata.provenance}
                                if derived.write.metadata is not None
                                and derived.write.metadata.provenance is not None
                                else {}
                            ),
                            **(
                                {"requestMessages": derived.request_messages}
                                if derived.request_messages is not None
                                else {}
                            ),
                            **(
                                {"rawResponse": derived.raw_response}
                                if derived.raw_response is not None
                                else {}
                            ),
                        },
                    ),
                )
            )
    return HandlerOk(derivations=[derived.write], on_applied=on_applied)


# The domain's handler table is merged into the SDK dispatch map at
# construction. Turn-owned kinds stay with the turns domain.
message_work_handlers: dict[WorkKind, WorkHandler] = {
    "prompt_smoothing": _smooth_prompt_handler,
    "tool_result_summary": _tool_result_summary_handler,
}
